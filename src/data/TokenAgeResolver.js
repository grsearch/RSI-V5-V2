/**
 * TokenAgeResolver
 * =================
 * 解决 Birdeye API 没有 token age 字段的问题
 *
 * 策略:
 *   1. 首选 Birdeye /defi/token_creation_info (CU 消耗低)
 *   2. fallback Helius getSignaturesForAddress 翻页找最早签名
 *   3. 永久缓存 createdAtSec(创建时间不变,只算 1 次)
 *   4. 失败冷却 60s(两条链路都失败的代币不反复打)
 *   5. warmupBatch 并发预热(新代币批量加入时用)
 */
const fs = require('fs');
const path = require('path');

const HELIUS_MAX_PAGES = 5;        // 翻页上限,5000 条签名
const FAIL_COOLDOWN_MS = 60_000;   // 双链路失败后 60s 不重试
const PERSIST_PATH = path.join(__dirname, '..', '..', 'data', 'token_age_cache.json');

class TokenAgeResolver {
  constructor(opts = {}) {
    this.birdeyeApiKey = opts.birdeyeApiKey || process.env.BIRDEYE_API_KEY;
    this.heliusApiKey = opts.heliusApiKey || process.env.HELIUS_API_KEY;
    this.heliusRpcUrl = opts.heliusRpcUrl
      || (this.heliusApiKey ? `https://mainnet.helius-rpc.com/?api-key=${this.heliusApiKey}` : null);

    // address -> createdAtSec (永久缓存,创建时间不变)
    this.cache = new Map();
    // address -> lastFailedAtMs (失败冷却)
    this.failedAt = new Map();

    this._loadCache();
  }

  _loadCache() {
    try {
      if (fs.existsSync(PERSIST_PATH)) {
        const data = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf-8'));
        for (const [k, v] of Object.entries(data)) this.cache.set(k, v);
        console.log(`[AGE] 加载 ${this.cache.size} 条 age 缓存`);
      }
    } catch (e) { /* skip */ }
  }

  _persistCache() {
    try {
      fs.mkdirSync(path.dirname(PERSIST_PATH), { recursive: true });
      const obj = {};
      for (const [k, v] of this.cache) obj[k] = v;
      fs.writeFileSync(PERSIST_PATH, JSON.stringify(obj));
    } catch (e) { /* skip */ }
  }

  /**
   * 拿 token 的 age (秒)
   * @returns {Promise<number|null>} age in seconds, or null if both sources failed
   */
  async getAge(address) {
    const created = await this.getCreatedAt(address);
    if (created == null) return null;
    return Math.floor(Date.now() / 1000) - created;
  }

  /**
   * 拿 token 的创建时间 (unix sec),供 age 计算和 listedAt 字段使用
   */
  async getCreatedAt(address) {
    if (this.cache.has(address)) return this.cache.get(address);

    const lastFail = this.failedAt.get(address);
    if (lastFail && Date.now() - lastFail < FAIL_COOLDOWN_MS) return null;

    // 1. 首选 Birdeye
    let createdAt = await this._fetchFromBirdeye(address);
    // 2. fallback Helius
    if (createdAt == null) {
      createdAt = await this._fetchFromHelius(address);
    }

    if (createdAt != null) {
      this.cache.set(address, createdAt);
      this.failedAt.delete(address);
      this._persistCache();
      return createdAt;
    }

    this.failedAt.set(address, Date.now());
    return null;
  }

  async _fetchFromBirdeye(address) {
    if (!this.birdeyeApiKey) return null;
    try {
      const url = `https://public-api.birdeye.so/defi/token_creation_info?address=${address}`;
      const res = await fetch(url, {
        headers: { 'X-API-KEY': this.birdeyeApiKey, 'x-chain': 'solana' },
      });
      if (!res.ok) return null;
      const json = await res.json();
      const t = json.data?.blockUnixTime;
      if (typeof t === 'number' && t > 1577836800) {  // sanity: > 2020-01-01
        return t;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  async _fetchFromHelius(address) {
    if (!this.heliusRpcUrl) return null;
    try {
      let oldestTime = null;
      let beforeSig = null;

      for (let page = 0; page < HELIUS_MAX_PAGES; page++) {
        const params = [address, { limit: 1000 }];
        if (beforeSig) params[1].before = beforeSig;

        const res = await fetch(this.heliusRpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getSignaturesForAddress', params,
          }),
        });
        if (!res.ok) return null;
        const json = await res.json();
        const sigs = json.result;
        if (!Array.isArray(sigs) || sigs.length === 0) break;

        const last = sigs[sigs.length - 1];
        if (last.blockTime) oldestTime = last.blockTime;

        if (sigs.length < 1000) break;  // 翻到底
        beforeSig = last.signature;
      }
      return oldestTime;
    } catch (e) {
      return null;
    }
  }

  /**
   * 批量预热(新加入一批 token 时用,并发 5 路)
   * @param {string[]} addresses
   */
  async warmupBatch(addresses) {
    const todo = addresses.filter(a => !this.cache.has(a));
    if (todo.length === 0) return;
    const CONCURRENCY = 5;
    let idx = 0;
    const workers = Array(CONCURRENCY).fill(null).map(async () => {
      while (idx < todo.length) {
        const i = idx++;
        await this.getCreatedAt(todo[i]);
      }
    });
    await Promise.all(workers);
    console.log(`[AGE] 预热完成: ${todo.length} 个新 token`);
  }
}

module.exports = TokenAgeResolver;
