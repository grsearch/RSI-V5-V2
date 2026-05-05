/**
 * StrategyOrchestrator
 * =====================
 * 为每个 token 创建一套独立的 (CandleAggregator + IndicatorEngine + Signal)
 * 路由 Helius 的 tick 事件到对应 token 的 aggregator
 * 处理 BUY/SELL 事件 → 调用 Executor 实际下单 (DRY_RUN 时只记录)
 *
 * Token 加入流程(2026-05-05 改):
 *   1. 创建 agg + ind + signal
 *   2. **从 Birdeye 拉历史 1m K 线预填充 RSI**(token 至少 1 天以上才有效)
 *   3. 订阅 Helius tick(实时增量)
 */
const { CandleAggregator, IndicatorEngine } = require('../data/IndicatorEngine');
const WickReversalSignal = require('./WickReversalSignal');
const HistoricalCandleLoader = require('../data/HistoricalCandleLoader');
const BirdeyePriceFeed = require('../data/BirdeyePriceFeed');
const Executor = require('../exec/Executor');

class StrategyOrchestrator {
  constructor(opts) {
    this.helius = opts.helius;
    this.tokenPool = opts.tokenPool;
    this.tradeLogger = opts.tradeLogger;
    this.config = opts.config;
    this.dryRun = opts.dryRun;

    this.instances = new Map();
    this.positions = new Map();

    this.executor = new Executor({
      dryRun: this.dryRun,
      walletPrivateKey: this.config.walletPrivateKey,
    });

    this.historicalLoader = new HistoricalCandleLoader({
      birdeyeApiKey: this.config.birdeyeApiKey,
      lookbackBars: 100,
    });

    // Birdeye 价格 feed 作为 Helius 的兜底
    // 每 30 秒拉一次最近 5 分钟的 1m candle,补充 closed candle 的 volume
    this.birdeyeFeed = new BirdeyePriceFeed({
      birdeyeApiKey: this.config.birdeyeApiKey,
      refreshIntervalMs: 30_000,
    });
  }

  async init() {
    await this.helius.connect();

    // 路由 Helius tick 到对应 token aggregator
    this.helius.on('tick', (tick) => {
      const inst = this.instances.get(tick.address);
      if (inst) inst.agg.onTick(tick);
    });

    // 监听 token 池变化(异步加入,不 block)
    this.tokenPool.on('token:added', (t) => {
      this._addInstance(t).catch(e =>
        console.error(`[ORCH] add ${t.symbol} failed:`, e.message));
    });
    this.tokenPool.on('token:removed', (t) => this._removeInstance(t));

    // 已有 token 启动监控(并发预热,不阻塞 init)
    const existing = this.tokenPool.getAll();
    Promise.all(existing.map(t => this._addInstance(t))).then(() => {
      console.log(`[ORCH] 全部 ${existing.length} 个 token 历史 K 线已加载`);
    });
    console.log(`[ORCH] 启动 ${existing.length} 个 token 监控(异步预热中)`);

    // 启动 Birdeye 兜底 feed(每 30s 补 closed candle volume)
    this.birdeyeFeed.start();
    console.log(`[ORCH] BirdeyeFeed 启动(每 30s 补 closed candle volume)`);
  }

  async _addInstance(tokenMeta) {
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

    // 注册到 instances 一定要在 signal.start() 前(否则 tick 进来路由不到)
    this.instances.set(tokenMeta.address, { agg, ind, signal, sub: null, tokenMeta });

    // 关键:先从 Birdeye 拉历史 K 线预填充,再启动 signal
    // 这样 signal 启动时 RSI 已经稳定,且 volume MA 基准已建立
    try {
      const result = await this.historicalLoader.loadAndPrefill(
        tokenMeta.address, agg, ind, signal);
      if (result.candleCount > 0) {
        console.log(`[ORCH] ${tokenMeta.symbol} 预填充 ${result.candleCount} 根 (${result.validVolumeCount} 根有量), ` +
          `RSI=${result.latestRsi?.toFixed(2)}, avgVol=${result.avgVolume?.toFixed(2)}, ` +
          `lastVol=${result.latestVolume?.toFixed(2)}`);
        if (result.validVolumeCount === 0) {
          console.warn(`[ORCH] ⚠️  ${tokenMeta.symbol} volume 全是 0!检查 Birdeye 是否支持此 token`);
        }
      } else {
        console.log(`[ORCH] ${tokenMeta.symbol} 历史 K 线为空(可能太新或 Birdeye 没数据),依赖实时 tick 累积`);
      }
    } catch (e) {
      console.error(`[ORCH] ${tokenMeta.symbol} 预填充失败:`, e.message);
    }

    // 订阅 Helius tick + 启动 signal
    const sub = this.helius.subscribeToken(tokenMeta.address);
    const inst = this.instances.get(tokenMeta.address);
    if (inst) inst.sub = sub;
    signal.start();

    // 注册到 BirdeyeFeed 兜底(每 30s 补 closed candle volume)
    this.birdeyeFeed.subscribe(tokenMeta.address, agg, ind, signal);
  }

  _removeInstance(tokenMeta) {
    const inst = this.instances.get(tokenMeta.address);
    if (!inst) return;
    inst.signal.stop();
    inst.sub.unsubscribe && inst.sub.unsubscribe();
    this.birdeyeFeed.unsubscribe(tokenMeta.address);
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

  /**
   * 拿单个 token 的实时状态(供 Dashboard 显示)
   */
  getInstanceState(address) {
    const inst = this.instances.get(address);
    if (!inst) return null;
    const cur = inst.agg.getCurrentCandle();
    const lastClosed = inst.agg.getCompletedCandles(1)[0];
    const rsi = inst.ind.getRSI();
    const prevRsi = inst.ind.getPrevRSI();
    const stepRsi = inst.ind.getStepRSI();
    return {
      lastPrice: cur?.close ?? lastClosed?.close ?? null,
      rsi,
      prevRsi,
      stepRsi,
      candleCount: inst.agg.completedCandles.length,
      hasPosition: this.positions.has(address),
      currentVolume: cur?.volume ?? 0,
    };
  }

  /**
   * 拿所有 token 的状态(供 Dashboard /api/tokens 用)
   */
  getAllInstanceStates() {
    const out = {};
    for (const [addr, _] of this.instances) {
      out[addr] = this.getInstanceState(addr);
    }
    return out;
  }
}

module.exports = StrategyOrchestrator;
