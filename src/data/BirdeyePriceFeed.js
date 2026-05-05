/**
 * BirdeyePriceFeed
 * =================
 * 用 Birdeye 1m candle 周期性拉取最新数据,补充 Helius tick 流
 *
 * 这是一个"备份数据源",当 Helius tick 流没接好/断线时,
 * 至少能保证 candle 关闭后 volume 有值,Signal 能正常工作
 *
 * 工作模式:
 *   每 30 秒拉一次最近 5 根 1m candle
 *   如果发现新关闭的 candle 与本地 aggregator 的 closed candle 不同,
 *   或者本地 candle.volume = 0 但 Birdeye 有 volume 数据,
 *   则用 Birdeye 数据覆盖
 *
 * 注意:
 *   - 这只覆盖 closed candle,不影响 intra-candle stepRSI
 *   - 与 Helius tick 流不冲突(tick 还是会更新 currentCandle)
 *   - 仅作为 closed-bar volume 的兜底
 */
const HistoricalCandleLoader = require('./HistoricalCandleLoader');

class BirdeyePriceFeed {
  constructor(opts) {
    this.loader = new HistoricalCandleLoader({
      birdeyeApiKey: opts.birdeyeApiKey,
      lookbackBars: 5,  // 只拉最近 5 根做兜底
    });
    this.refreshIntervalMs = opts.refreshIntervalMs || 30_000;
    this.timer = null;
    // address -> { agg, ind, signal, lastVolumeRefreshTs }
    this.subscribers = new Map();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._refreshAll(), this.refreshIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  subscribe(address, agg, ind, signal) {
    this.subscribers.set(address, { agg, ind, signal, lastRefresh: 0 });
  }

  unsubscribe(address) {
    this.subscribers.delete(address);
  }

  async _refreshAll() {
    for (const [address, ctx] of this.subscribers) {
      try {
        await this._refreshOne(address, ctx);
      } catch (e) { /* skip */ }
    }
  }

  async _refreshOne(address, ctx) {
    const candles = await this.loader._fetchBirdeyeOhlcv(
      address,
      Math.floor(Date.now() / 1000) - 600,  // 最近 10 分钟
      Math.floor(Date.now() / 1000)
    );
    if (!candles || candles.length === 0) return;

    const now = Math.floor(Date.now() / 1000);
    const currentMinuteStart = Math.floor(now / 60) * 60;

    // 只看 closed candles(ts < currentMinuteStart)
    const closed = candles.filter(c => c.ts < currentMinuteStart);
    if (closed.length === 0) return;

    // 与本地 aggregator 的 closed candles 对比
    const localCandles = ctx.agg.completedCandles;
    const localByTs = new Map(localCandles.map(c => [c.ts, c]));

    let updated = 0;
    for (const remote of closed) {
      const local = localByTs.get(remote.ts);
      if (!local) {
        // 本地没有这根 candle(可能是新关闭的,Helius 没接到)→ 补
        ctx.agg.completedCandles.push({ ...remote });
        updated++;
      } else if (local.volume === 0 && remote.volume > 0) {
        // 本地有这根 candle 但 volume=0,远端有 → 用远端补 volume
        local.volume = remote.volume;
        // 同时校正 close 价格(避免 Helius 没接到价格变化)
        local.close = remote.close;
        local.high = Math.max(local.high, remote.high);
        local.low = Math.min(local.low, remote.low);
        updated++;
      }
    }

    if (updated > 0) {
      // 重新排序 + 限制大小
      ctx.agg.completedCandles.sort((a, b) => a.ts - b.ts);
      if (ctx.agg.completedCandles.length > ctx.agg.maxCandles) {
        ctx.agg.completedCandles = ctx.agg.completedCandles.slice(-ctx.agg.maxCandles);
      }

      // 同步 signal.completedVolumes
      if (ctx.signal) {
        const validVols = ctx.agg.completedCandles
          .map(c => c.volume).filter(v => v > 0);
        ctx.signal.completedVolumes = validVols.slice(-30);
      }

      // RSI 不重新算(避免和 Helius 冲突),只补 volume
      // 如果连 Helius RSI 都没有,这里需要重算 RSI:
      // 仅在 signal.completedVolumes 之前为空时才重新喂 RSI
      if (ctx.ind.rsi.getCurrent() == null) {
        // RSI 序列空,完整重建
        const rsiCalc = ctx.ind.rsi;
        rsiCalc.prevClose = null;
        rsiCalc.avgGain = null;
        rsiCalc.avgLoss = null;
        rsiCalc.gainsBuf = [];
        rsiCalc.lossesBuf = [];
        rsiCalc.history = [];
        for (const c of ctx.agg.completedCandles) {
          rsiCalc.update(c.close);
        }
      }
    }
  }
}

module.exports = BirdeyePriceFeed;
