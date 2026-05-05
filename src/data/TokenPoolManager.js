/**
 * TokenPoolManager
 * =================
 * 职责:
 *   - 维护监控中的 token 列表
 *   - 定期检查每个 token 的 FDV 和 LP
 *   - FDV < minFdv 或 LP < minLpUsd 自动移除
 *   - 移除前调用 onTokenRemoved 回调(用于平仓)
 *   - 接受 webhook / 手动添加 / 来自 pumpmoniter 的 token
 */
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

class TokenPoolManager extends EventEmitter {
  constructor(opts) {
    super();
    this.minFdv = opts.minFdv;
    this.minLpUsd = opts.minLpUsd;
    this.refreshIntervalMs = opts.refreshIntervalMs || 30_000;
    this.onTokenRemoved = opts.onTokenRemoved || (() => {});
    this.persistPath = opts.persistPath || path.join(__dirname, '..', '..', 'data', 'token_pool.json');

    // address -> tokenMeta
    // tokenMeta: { address, symbol, addedAt, listedAt, fdv, lpUsd, lpSol,
    //               topHolderPct, mintAuthority, freezeAuthority, lastChecked }
    this.tokens = new Map();
    this.refreshTimer = null;
  }

  async init() {
    // 加载持久化的 token 列表
    if (fs.existsSync(this.persistPath)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'));
        for (const t of saved) {
          this.tokens.set(t.address, t);
        }
        console.log(`[POOL] 加载 ${this.tokens.size} 个已保存 token`);
      } catch (e) {
        console.error('[POOL] 加载失败:', e.message);
      }
    }

    // 启动定期刷新
    this.refreshTimer = setInterval(() => this._refresh(), this.refreshIntervalMs);
    // 立即跑一次
    setImmediate(() => this._refresh());
  }

  /**
   * 添加 token (来自 webhook / 手动 / pumpmoniter)
   * @param {Object} req { network, address, symbol, listedAt? }
   */
  async addToken(req) {
    if (req.network && req.network !== 'solana') {
      throw new Error(`只支持 solana, 收到 ${req.network}`);
    }
    if (!req.address) throw new Error('address 必填');
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(req.address)) {
      throw new Error('地址格式不对');
    }

    if (this.tokens.has(req.address)) {
      return { ok: true, msg: '已存在,跳过', token: this.tokens.get(req.address) };
    }

    // 拉一次 FDV/LP 验证可用
    const meta = await this._fetchTokenMeta(req.address);
    if (!meta) {
      throw new Error('Birdeye/链上查询失败,该 token 可能不存在');
    }
    if (meta.fdv && meta.fdv < this.minFdv) {
      return { ok: false, msg: `FDV ${meta.fdv} < ${this.minFdv},拒绝加入` };
    }
    if (meta.lpUsd && meta.lpUsd < this.minLpUsd) {
      return { ok: false, msg: `LP ${meta.lpUsd} < ${this.minLpUsd},拒绝加入` };
    }

    const tokenMeta = {
      address: req.address,
      symbol: req.symbol || meta.symbol || req.address.slice(0, 6),
      addedAt: Date.now(),
      listedAt: meta.listedAt || Date.now(),
      fdv: meta.fdv,
      lpUsd: meta.lpUsd,
      lpSol: meta.lpSol,
      topHolderPct: meta.topHolderPct,
      mintAuthority: meta.mintAuthority,
      freezeAuthority: meta.freezeAuthority,
      lastChecked: Date.now(),
    };
    this.tokens.set(req.address, tokenMeta);
    this._persist();
    this.emit('token:added', tokenMeta);
    console.log(`[POOL] + 加入 ${tokenMeta.symbol} (${tokenMeta.address.slice(0,6)}) FDV=$${tokenMeta.fdv?.toFixed(0)} LP=$${tokenMeta.lpUsd?.toFixed(0)}`);
    return { ok: true, token: tokenMeta };
  }

  removeToken(address, reason = 'MANUAL') {
    const t = this.tokens.get(address);
    if (!t) return false;
    this.tokens.delete(address);
    this._persist();
    this.emit('token:removed', t, reason);
    // 异步触发回调(平仓)
    Promise.resolve(this.onTokenRemoved(t, reason)).catch(e => {
      console.error(`[POOL] onTokenRemoved error:`, e);
    });
    return true;
  }

  getAll() {
    return Array.from(this.tokens.values());
  }

  get(address) {
    return this.tokens.get(address);
  }

  /**
   * 定期刷新所有 token 的 FDV/LP/holder/authority
   */
  async _refresh() {
    const tokens = this.getAll();
    if (tokens.length === 0) return;

    for (const t of tokens) {
      try {
        const meta = await this._fetchTokenMeta(t.address);
        if (!meta) {
          // 拉不到数据,标记一下,但不立刻移除(可能是临时网络问题)
          continue;
        }
        // 更新元数据
        t.fdv = meta.fdv;
        t.lpUsd = meta.lpUsd;
        t.lpSol = meta.lpSol;
        t.topHolderPct = meta.topHolderPct;
        t.mintAuthority = meta.mintAuthority;
        t.freezeAuthority = meta.freezeAuthority;
        t.lastChecked = Date.now();

        // 检查移除条件
        let removeReason = null;
        if (meta.fdv != null && meta.fdv < this.minFdv) {
          removeReason = `FDV_TOO_LOW($${meta.fdv.toFixed(0)}<$${this.minFdv})`;
        } else if (meta.lpUsd != null && meta.lpUsd < this.minLpUsd) {
          removeReason = `LP_TOO_LOW($${meta.lpUsd.toFixed(0)}<$${this.minLpUsd})`;
        }

        if (removeReason) {
          console.log(`[POOL] - 自动移除 ${t.symbol}: ${removeReason}`);
          this.removeToken(t.address, removeReason);
        }
      } catch (e) {
        // 拉取失败,不移除
      }
    }
    this._persist();
  }

  /**
   * 拉取 token 元数据(FDV / LP / holder / authority)
   * 实际应该接 Birdeye + Helius
   */
  async _fetchTokenMeta(address) {
    // TODO: 接入 Birdeye token_overview API + Helius getTokenLargestAccounts
    // 这里返回 mock 给框架调通
    if (process.env.MOCK_TOKEN_META === '1') {
      return {
        symbol: address.slice(0, 6),
        fdv: 200_000 + Math.random() * 1_000_000,
        lpUsd: 30_000 + Math.random() * 100_000,
        lpSol: 100 + Math.random() * 500,
        topHolderPct: 0.3 + Math.random() * 0.4,
        mintAuthority: null,
        freezeAuthority: null,
        listedAt: Date.now() - Math.random() * 30 * 86400 * 1000,
      };
    }

    try {
      const url = `https://public-api.birdeye.so/defi/token_overview?address=${address}`;
      const res = await fetch(url, {
        headers: {
          'X-API-KEY': process.env.BIRDEYE_API_KEY || '',
          'x-chain': 'solana',
        },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const d = data.data || {};
      return {
        symbol: d.symbol,
        fdv: d.fdv || d.mc,
        lpUsd: d.liquidity,
        lpSol: d.liquidity ? d.liquidity / (d.solPriceUsd || 200) : null,
        topHolderPct: null,  // Birdeye 不直接提供,需要 Helius getTokenLargestAccounts
        mintAuthority: d.mintAuthority,
        freezeAuthority: d.freezeAuthority,
        listedAt: d.createdTime ? d.createdTime * 1000 : null,
      };
    } catch (e) {
      return null;
    }
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify(this.getAll(), null, 2));
    } catch (e) {
      console.error('[POOL] 持久化失败:', e.message);
    }
  }
}

module.exports = TokenPoolManager;
