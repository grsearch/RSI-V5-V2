/**
 * HistoricalCandleLoader
 * =======================
 * 从 Birdeye 拉历史 1m K 线,预填充 CandleAggregator 和 IndicatorEngine
 *
 * 关键设计(对应你 V5 时代的"历史/实时合并"经验):
 *   1. 拉取最近 N 根 1m K 线(默认 100,确保 RSI 稳定)
 *   2. 用 candle.ts(unixTime,1m 对齐)作为 key,与实时 tick 流的 candle 合并
 *   3. 历史 candle 直接 push 到 aggregator.completedCandles + 喂入 RSI
 *   4. 第一根实时 tick 进来时:
 *      a. 如果 tick 落在最后一根历史 candle 的 60s 内 → 该历史 candle 视为"未关闭",
 *         继续累加 → 但这种情况下 volume 会被低估(只有部分时间的实时数据)
 *      b. 如果 tick 落在新的 1m 窗口 → 历史 candle 已 closed,正常推进
 *
 * 我们采取保守策略:
 *   - 历史拉到 candle.ts 严格 < 当前 1m 窗口起点(最后一根历史 candle 已完整关闭)
 *   - 这样实时 tick 流自然从下一根 1m 开始,不重叠
 */

const RSI = require('./IndicatorEngine').RSICalculator;

class HistoricalCandleLoader {
  constructor(opts) {
    this.birdeyeApiKey = opts.birdeyeApiKey || process.env.BIRDEYE_API_KEY;
    this.lookbackBars = opts.lookbackBars || 100;  // 拉 100 根足够 RSI(7) 充分稳定
  }

  /**
   * 为 token 拉历史 K 线并填充 aggregator + indicator + signal volume buffer
   * @param {string} address  token mint
   * @param {CandleAggregator} aggregator
   * @param {IndicatorEngine} indicatorEngine
   * @param {WickReversalSignal} [signal]  可选,会同时填充 signal.completedVolumes
   * @returns {Promise<{ candleCount, latestRsi, avgVolume, latestVolume }>}
   */
  async loadAndPrefill(address, aggregator, indicatorEngine, signal) {
    const now = Math.floor(Date.now() / 1000);
    const currentMinuteStart = Math.floor(now / 60) * 60;
    const timeTo = currentMinuteStart;
    const timeFrom = timeTo - this.lookbackBars * 60;

    const candles = await this._fetchBirdeyeOhlcv(address, timeFrom, timeTo);
    if (!candles || candles.length === 0) {
      return { candleCount: 0, latestRsi: null, avgVolume: 0, latestVolume: 0 };
    }

    // 排序 + 去重(按 ts)
    const seen = new Set();
    const sorted = candles
      .filter(c => {
        if (seen.has(c.ts)) return false;
        seen.add(c.ts);
        return c.ts < currentMinuteStart;  // 严格小于,不重叠
      })
      .sort((a, b) => a.ts - b.ts);

    if (sorted.length === 0) {
      return { candleCount: 0, latestRsi: null, avgVolume: 0, latestVolume: 0 };
    }

    // ===== 注入 aggregator =====
    aggregator.completedCandles = sorted.slice();
    if (aggregator.completedCandles.length > aggregator.maxCandles) {
      aggregator.completedCandles =
        aggregator.completedCandles.slice(-aggregator.maxCandles);
    }

    // ===== 喂入 RSI 计算器 =====
    for (const c of sorted) {
      indicatorEngine.rsi.update(c.close);
    }

    // ===== 关键:填充 signal 自己维护的 completedVolumes(MA20 基准)=====
    if (signal) {
      // 只放 volume > 0 的(零量 bar 会拉低基准)
      const volumes = sorted.map(c => c.volume).filter(v => v > 0);
      signal.completedVolumes = volumes.slice(-30);  // 保留最近 30 根
    }

    const latestRsi = indicatorEngine.rsi.getCurrent();
    const validVols = sorted.map(c => c.volume).filter(v => v > 0);
    const avgVolume = validVols.length
      ? validVols.reduce((a, b) => a + b, 0) / validVols.length : 0;
    const latestVolume = sorted[sorted.length - 1].volume;

    return {
      candleCount: sorted.length,
      latestRsi,
      avgVolume,
      latestVolume,
      validVolumeCount: validVols.length,
    };
  }

  /**
   * 拉 Birdeye 1m OHLCV(优先 v3,fallback v1)
   *
   * 关键字段(实测):
   *   v3:  unixTime, o, h, l, c, v (token amount), v_usd (USD value)
   *   v1:  unixTime, o, h, l, c, v
   *
   * 注意:某些刚 migrate 的小币 v3 可能返回 [],这时降级 v1
   */
  async _fetchBirdeyeOhlcv(address, timeFrom, timeTo) {
    if (!this.birdeyeApiKey) {
      console.error('[HCL] BIRDEYE_API_KEY 未设置');
      return null;
    }

    let candles = await this._fetchOhlcvV3(address, timeFrom, timeTo);
    if (!candles || candles.length === 0) {
      console.log(`[HCL] ${address.slice(0,6)} v3 空,fallback v1`);
      candles = await this._fetchOhlcvV1(address, timeFrom, timeTo);
    }
    return candles;
  }

  async _fetchOhlcvV3(address, timeFrom, timeTo) {
    const all = [];
    let cursor = timeFrom;
    let firstResponse = true;
    while (cursor < timeTo) {
      const chunkEnd = Math.min(cursor + 5000 * 60, timeTo);
      try {
        const url = `https://public-api.birdeye.so/defi/v3/ohlcv?` +
          `address=${address}&type=1m&currency=usd` +
          `&time_from=${cursor}&time_to=${chunkEnd}`;
        const res = await fetch(url, {
          headers: { 'X-API-KEY': this.birdeyeApiKey, 'x-chain': 'solana' },
        });
        if (!res.ok) {
          console.error(`[HCL] v3 HTTP ${res.status} for ${address.slice(0,6)}`);
          return null;
        }
        const json = await res.json();
        const items = json.data?.items || [];

        // 第一次响应:打印原始字段,确认字段名
        if (firstResponse && items.length > 0) {
          firstResponse = false;
          console.log(`[HCL] v3 sample fields for ${address.slice(0,6)}:`,
            Object.keys(items[0]).join(','),
            `| sample: o=${items[0].o} v=${items[0].v} v_usd=${items[0].v_usd}`);
        }

        if (items.length === 0) break;
        for (const it of items) {
          // v 是 token amount, v_usd 是 USD 价值
          // 我们用 v_usd 作为 volume(更稳定的相对量纲)
          // 但如果 v_usd 没有,降级用 v
          const vol = (typeof it.v_usd === 'number' && it.v_usd > 0)
            ? Number(it.v_usd)
            : Number(it.v || 0);
          all.push({
            ts: it.unixTime,
            open: Number(it.o),
            high: Number(it.h),
            low: Number(it.l),
            close: Number(it.c),
            volume: vol,
          });
        }
        const lastTs = items[items.length - 1].unixTime;
        if (lastTs <= cursor) break;
        cursor = lastTs + 60;
      } catch (e) {
        console.error(`[HCL] v3 fetch error:`, e.message);
        return null;
      }
    }
    return all;
  }

  async _fetchOhlcvV1(address, timeFrom, timeTo) {
    const all = [];
    let cursor = timeFrom;
    while (cursor < timeTo) {
      const chunkEnd = Math.min(cursor + 1000 * 60, timeTo);
      try {
        const url = `https://public-api.birdeye.so/defi/ohlcv?` +
          `address=${address}&type=1m&time_from=${cursor}&time_to=${chunkEnd}`;
        const res = await fetch(url, {
          headers: { 'X-API-KEY': this.birdeyeApiKey, 'x-chain': 'solana' },
        });
        if (!res.ok) break;
        const json = await res.json();
        const items = json.data?.items || [];
        if (items.length === 0) break;
        for (const it of items) {
          all.push({
            ts: it.unixTime,
            open: Number(it.o),
            high: Number(it.h),
            low: Number(it.l),
            close: Number(it.c),
            volume: Number(it.v || 0),
          });
        }
        const lastTs = items[items.length - 1].unixTime;
        if (lastTs <= cursor) break;
        cursor = lastTs + 60;
      } catch (e) {
        console.error(`[HCL] v1 fetch error:`, e.message);
        break;
      }
    }
    return all;
  }
}

module.exports = HistoricalCandleLoader;
