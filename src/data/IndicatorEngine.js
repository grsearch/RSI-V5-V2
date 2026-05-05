/**
 * CandleAggregator + IndicatorEngine
 * ====================================
 * 对齐你 V6 的 TickBus → CandleAggregator → IndicatorEngine 架构
 *
 * 用法:
 *   const agg = new CandleAggregator(60);  // 1m candles
 *   const ind = new IndicatorEngine(agg, { rsiPeriod: 7 });
 *   agg.onTick({ price, sol_amount, ts });
 *   ind.getRSI();        // closed-bar RSI
 *   ind.getStepRSI();    // intra-candle RSI
 *   agg.on('candle:closed', (candle) => { ... });
 */
const EventEmitter = require('events');

class CandleAggregator extends EventEmitter {
  constructor(periodSec = 60) {
    super();
    this.periodSec = periodSec;
    this.currentCandle = null;
    this.completedCandles = [];   // 最近 N 根
    this.maxCandles = 500;
  }

  onTick(tick) {
    const ts = tick.ts;
    const candleStart = Math.floor(ts / this.periodSec) * this.periodSec;

    if (!this.currentCandle || this.currentCandle.ts !== candleStart) {
      // 关闭上一根
      if (this.currentCandle) {
        this.completedCandles.push(this.currentCandle);
        if (this.completedCandles.length > this.maxCandles) {
          this.completedCandles.shift();
        }
        this.emit('candle:closed', this.currentCandle);
      }
      // 开新一根
      this.currentCandle = {
        ts: candleStart,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: 0,
        ticks: 0,
      };
    }

    const c = this.currentCandle;
    if (tick.price > c.high) c.high = tick.price;
    if (tick.price < c.low) c.low = tick.price;
    c.close = tick.price;
    c.volume += tick.sol_amount || 0;
    c.ticks++;

    this.emit('tick', tick);
  }

  getCurrentCandle() {
    return this.currentCandle;
  }

  getCurrentCandleStartTs() {
    return this.currentCandle ? this.currentCandle.ts : null;
  }

  getCompletedCandles(n) {
    return this.completedCandles.slice(-n);
  }
}


// Wilder RSI
class RSICalculator {
  constructor(period = 7) {
    this.period = period;
    this.prevClose = null;
    this.avgGain = null;
    this.avgLoss = null;
    this.gainsBuf = [];
    this.lossesBuf = [];
    this.history = [];  // 最近 RSI 值
    this.maxHistory = 100;
  }

  update(close) {
    if (this.prevClose == null) {
      this.prevClose = close;
      return null;
    }
    const change = close - this.prevClose;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    this.prevClose = close;

    if (this.avgGain == null) {
      this.gainsBuf.push(gain);
      this.lossesBuf.push(loss);
      if (this.gainsBuf.length < this.period) return null;
      this.avgGain = this.gainsBuf.reduce((a,b)=>a+b,0) / this.period;
      this.avgLoss = this.lossesBuf.reduce((a,b)=>a+b,0) / this.period;
    } else {
      this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period;
      this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period;
    }

    let rsi;
    if (this.avgLoss === 0) rsi = 100;
    else {
      const rs = this.avgGain / this.avgLoss;
      rsi = 100 - 100 / (1 + rs);
    }
    this.history.push(rsi);
    if (this.history.length > this.maxHistory) this.history.shift();
    return rsi;
  }

  /**
   * 不污染状态地"试算"一个 RSI(用于 stepRSI:intra-candle 临时 close)
   */
  preview(tempClose) {
    if (this.prevClose == null || this.avgGain == null) return null;
    const change = tempClose - this.prevClose;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    const tempAvgGain = (this.avgGain * (this.period - 1) + gain) / this.period;
    const tempAvgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period;
    if (tempAvgLoss === 0) return 100;
    const rs = tempAvgGain / tempAvgLoss;
    return 100 - 100 / (1 + rs);
  }

  getCurrent() { return this.history[this.history.length - 1] ?? null; }
  getPrev()    { return this.history[this.history.length - 2] ?? null; }
}


class IndicatorEngine {
  constructor(aggregator, opts = {}) {
    this.aggregator = aggregator;
    this.rsi = new RSICalculator(opts.rsiPeriod || 7);
    this.stepRsiHistory = [];
    this.maxStepHistory = 60;

    // 监听 candle 关闭,更新 closed-bar RSI
    aggregator.on('candle:closed', (c) => {
      this.rsi.update(c.close);
    });

    // 监听 tick,更新 stepRSI
    aggregator.on('tick', (tick) => {
      const cur = aggregator.getCurrentCandle();
      if (!cur) return;
      const step = this.rsi.preview(cur.close);
      if (step != null) {
        this.stepRsiHistory.push(step);
        if (this.stepRsiHistory.length > this.maxStepHistory) {
          this.stepRsiHistory.shift();
        }
      }
    });
  }

  getRSI()         { return this.rsi.getCurrent(); }
  getPrevRSI()     { return this.rsi.getPrev(); }
  getStepRSI()     { return this.stepRsiHistory[this.stepRsiHistory.length - 1] ?? null; }
  getPrevStepRSI() { return this.stepRsiHistory[this.stepRsiHistory.length - 2] ?? null; }
}

module.exports = { CandleAggregator, IndicatorEngine, RSICalculator };
