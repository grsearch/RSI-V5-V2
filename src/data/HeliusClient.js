/**
 * HeliusClient
 * =============
 * 包装 Helius LaserStream / Geyser WebSocket
 * - subscribeToken(address, handlers): 订阅单个 token 的所有 swap
 * - 内部 emit 'tick' { address, price, sol_amount, ts, type: 'BUY'|'SELL' }
 *
 * 注意:这里只给骨架,实际 _extractTrade 解析 Pump AMM / Raydium / Meteora
 * 的 swap 指令需要按你 V5 已有的 _extractTrade 来填,这部分你最熟悉
 */
const EventEmitter = require('events');

class HeliusClient extends EventEmitter {
  constructor(opts) {
    super();
    this.apiKey = opts.apiKey;
    this.endpoint = opts.endpoint;
    this.region = opts.region || 'tokyo';
    this.subscriptions = new Map();  // address -> subscription handle
    this.ws = null;
    this.reconnectDelay = 1000;
    this.connected = false;
  }

  async connect() {
    // 实际实现:连接到 wss://laserstream-mainnet-tokyo.helius-rpc.com
    // 用 transactionSubscribe + accountInclude
    // 推荐 commitment: 'processed' (省 400-800ms)
    console.log(`[HELIUS] 连接 ${this.region} 节点...`);
    // 占位,实盘填充
    this.connected = true;
    this.emit('connected');
  }

  /**
   * 订阅一个 token 的所有 swap 事件
   * @param {string} address  token mint
   * @returns {{ unsubscribe: () => void }}
   */
  subscribeToken(address) {
    if (this.subscriptions.has(address)) {
      return this.subscriptions.get(address);
    }

    // 实际:发送 transactionSubscribe { accountInclude: [pump_amm_for_this_token, raydium_pool, ...] }
    // 接收 tx → _extractTrade(tx) → emit 'tick'
    const sub = {
      address,
      unsubscribe: () => {
        this.subscriptions.delete(address);
        // 发送 unsubscribe
      },
    };
    this.subscriptions.set(address, sub);
    return sub;
  }

  /**
   * _extractTrade(tx) - 这里只放接口,实际解析逻辑按你 V5 已有的 _extractTrade()
   * 输入:Helius 推送的 tx
   * 输出:{ address, price, sol_amount, ts, type: 'BUY'|'SELL', signer } 或 null
   */
  _extractTrade(tx) {
    // TODO: 复用你 V5/V6 的 _extractTrade()
    // 这里只占位
    return null;
  }

  /**
   * 模拟模式:用于 DRY_RUN 时,如果没真实订阅,可以喂入合成 tick 测流程
   */
  injectMockTick(address, tick) {
    this.emit('tick', { address, ...tick });
  }
}

module.exports = HeliusClient;
