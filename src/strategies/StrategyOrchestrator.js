/**
 * StrategyOrchestrator
 * =====================
 * 为每个 token 创建一套独立的 (CandleAggregator + IndicatorEngine + Signal)
 * 路由 Helius 的 tick 事件到对应 token 的 aggregator
 * 处理 BUY/SELL 事件 → 调用 Executor 实际下单 (DRY_RUN 时只记录)
 */
const { CandleAggregator, IndicatorEngine } = require('../data/IndicatorEngine');
const WickReversalSignal = require('./WickReversalSignal');
const Executor = require('../exec/Executor');

class StrategyOrchestrator {
  constructor(opts) {
    this.helius = opts.helius;
    this.tokenPool = opts.tokenPool;
    this.tradeLogger = opts.tradeLogger;
    this.config = opts.config;
    this.dryRun = opts.dryRun;

    // address -> { agg, ind, signal, sub, tokenMeta }
    this.instances = new Map();
    // address -> { entryPrice, entryTs, sizeSol, ... } 当前持仓
    this.positions = new Map();

    this.executor = new Executor({
      dryRun: this.dryRun,
      walletPrivateKey: this.config.walletPrivateKey,
    });
  }

  async init() {
    await this.helius.connect();

    // 路由 Helius tick 到对应 token aggregator
    this.helius.on('tick', (tick) => {
      const inst = this.instances.get(tick.address);
      if (inst) inst.agg.onTick(tick);
    });

    // 监听 token 池变化
    this.tokenPool.on('token:added', (t) => this._addInstance(t));
    this.tokenPool.on('token:removed', (t) => this._removeInstance(t));

    // 已有 token 启动监控
    for (const t of this.tokenPool.getAll()) {
      this._addInstance(t);
    }
    console.log(`[ORCH] 启动 ${this.instances.size} 个 token 监控`);
  }

  _addInstance(tokenMeta) {
    if (this.instances.has(tokenMeta.address)) return;

    const agg = new CandleAggregator(60);
    const ind = new IndicatorEngine(agg, { rsiPeriod: this.config.strategy.rsiPeriod });
    const signal = new WickReversalSignal({
      tokenMeta,
      candleAggregator: agg,
      indicatorEngine: ind,
      config: this.config.strategy,
    });

    signal.on('BUY', (evt) => this._onBuySignal(evt, tokenMeta));
    signal.on('SELL', (evt) => this._onSellSignal(evt, tokenMeta));
    signal.on('SKIP', (evt) => this.tradeLogger.logSignal({ type: 'SKIP', ...evt }));

    const sub = this.helius.subscribeToken(tokenMeta.address);
    signal.start();

    this.instances.set(tokenMeta.address, { agg, ind, signal, sub, tokenMeta });
  }

  _removeInstance(tokenMeta) {
    const inst = this.instances.get(tokenMeta.address);
    if (!inst) return;
    inst.signal.stop();
    inst.sub.unsubscribe && inst.sub.unsubscribe();
    this.instances.delete(tokenMeta.address);
  }

  // ============================================================
  // BUY/SELL 处理
  // ============================================================
  async _onBuySignal(evt, tokenMeta) {
    if (this.positions.has(tokenMeta.address)) {
      console.log(`[ORCH] ${tokenMeta.symbol} BUY 跳过(已有持仓)`);
      return;
    }
    // 风控:总敞口
    const totalExposure = Array.from(this.positions.values())
      .reduce((s, p) => s + p.sizeSol, 0);
    if (totalExposure >= this.config.maxTotalExposureSol) {
      this.tradeLogger.logSignal({ type: 'SKIP_EXPOSURE', symbol: tokenMeta.symbol });
      return;
    }
    // 仓位大小:取 LP×1.5% 和 positionSizeSol 的较小值
    const lpLimit = (tokenMeta.lpSol || 100) * this.config.maxLpPercent;
    const sizeSol = Math.min(this.config.positionSizeSol, lpLimit);

    this.tradeLogger.logSignal({
      type: 'BUY_SIGNAL', symbol: tokenMeta.symbol, ...evt, sizeSol,
    });

    try {
      const result = await this.executor.swapSolToToken({
        tokenAddress: tokenMeta.address,
        amountSol: sizeSol,
        slippageBps: 1500,
      });
      if (result.ok) {
        this.positions.set(tokenMeta.address, {
          tokenMeta,
          entryPrice: result.actualPrice || evt.price,
          entryTs: evt.ts,
          sizeSol,
          tokenAmount: result.tokenAmount,
          entryReason: evt.reason,
          entryRsi: evt.rsi,
        });
        console.log(`[BUY] ${tokenMeta.symbol} @ ${result.actualPrice} size=${sizeSol} SOL`);
      }
    } catch (e) {
      console.error(`[BUY ERROR] ${tokenMeta.symbol}:`, e.message);
      this.tradeLogger.logSignal({ type: 'BUY_FAIL', symbol: tokenMeta.symbol, error: e.message });
    }
  }

  async _onSellSignal(evt, tokenMeta) {
    const pos = this.positions.get(tokenMeta.address);
    if (!pos) return;

    try {
      const result = await this.executor.swapTokenToSol({
        tokenAddress: tokenMeta.address,
        tokenAmount: pos.tokenAmount,
        slippageBps: 1500,
      });
      if (result.ok) {
        const pnlSol = (result.solAmount || 0) - pos.sizeSol;
        const pnlPct = pnlSol / pos.sizeSol;
        this.tradeLogger.logTrade({
          symbol: tokenMeta.symbol,
          address: tokenMeta.address,
          entryTs: pos.entryTs,
          entryPrice: pos.entryPrice,
          entrySol: pos.sizeSol,
          entryReason: pos.entryReason,
          entryRsi: pos.entryRsi,
          exitTs: evt.ts,
          exitPrice: result.actualPrice || evt.price,
          exitSol: result.solAmount,
          exitReason: evt.reason,
          pnlSol,
          pnlPct,
          holdMinutes: (evt.ts - pos.entryTs) / 60_000,
        });
        console.log(`[SELL] ${tokenMeta.symbol} pnl=${pnlSol.toFixed(4)} SOL (${(pnlPct*100).toFixed(2)}%) reason=${evt.reason}`);
      }
    } catch (e) {
      console.error(`[SELL ERROR] ${tokenMeta.symbol}:`, e.message);
      // SELL 失败必须重试
      this.tradeLogger.logSignal({ type: 'SELL_FAIL', symbol: tokenMeta.symbol, error: e.message });
    } finally {
      this.positions.delete(tokenMeta.address);
    }
  }

  /**
   * 强制平仓(token 被移除时调用)
   */
  async forceClosePosition(address, reason) {
    const pos = this.positions.get(address);
    if (!pos) return;
    console.log(`[FORCE_CLOSE] ${pos.tokenMeta.symbol} reason=${reason}`);
    await this._onSellSignal({
      ts: Date.now(),
      reason: 'FORCE_CLOSE_' + reason,
      price: pos.entryPrice,
    }, pos.tokenMeta);
  }

  async shutdownAll() {
    console.log(`[ORCH] 平掉 ${this.positions.size} 个持仓...`);
    for (const [addr, pos] of this.positions) {
      await this.forceClosePosition(addr, 'SHUTDOWN');
    }
  }

  getPositions() {
    return Array.from(this.positions.values());
  }
}

module.exports = StrategyOrchestrator;
