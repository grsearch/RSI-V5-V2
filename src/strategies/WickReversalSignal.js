/**
 * WickReversalSignal
 * ===================
 * 核心信号:RSI(7) < 10 + Volume × N → BUY
 * 出场:RSI 下穿 70 / RSI >= 80 / -8% / 15min
 *
 * 此处先用"纯净版":只 RSI<10 + Vol×N,不带 EMA99/SLOPE 过滤
 * 等用户确认是否要叠加 V4 多条件过滤后,再扩展
 */
const EventEmitter = require('events');

class WickReversalSignal extends EventEmitter {
  constructor(opts) {
    super();
    this.tokenMeta = opts.tokenMeta;
    this.agg = opts.candleAggregator;
    this.ind = opts.indicatorEngine;
    this.cfg = opts.config;

    // 动态量能阈值(按 FDV)
    this.volMult = this._getVolMultByFdv(this.tokenMeta.fdv);

    // 量能 MA 维护(只用 closed candles 算,排除当前 bar 和零量 bar)
    this.completedVolumes = [];

    // 状态
    this.position = null;             // { entryPrice, entryTs, hardStopPrice, timeStopTs, peakPrice, stopLossViolationCount }
    this.rsiBelowCount = 0;
    this.lastExitTs = 0;
    this.dailyTradeCount = 0;
    this.dailyResetTs = this._bjtTodayStart();
    this.intraTriggered = false;
    this._lastCrossedDownCandleTs = null;  // A1: 防止同一根 closed candle 重复触发 RSI_CROSS_DOWN_70

    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;

    this.agg.on('candle:closed', (c) => this._onCandleClose(c));
    this.agg.on('tick', (tick) => this._onTick(tick));
  }

  stop() { this.started = false; }

  // ============================================================
  _onCandleClose(candle) {
    if (!this.started) return;
    if (candle.volume > 0) this.completedVolumes.push(candle.volume);
    if (this.completedVolumes.length > 30) this.completedVolumes.shift();

    this.intraTriggered = false;

    if (this.position) return;

    const rsi = this.ind.getRSI();
    const prevRsi = this.ind.getPrevRSI();
    if (rsi == null || prevRsi == null) return;

    // closed-bar:RSI 首次下穿 10 + 量能确认
    if (prevRsi >= this.cfg.rsiBuyThreshold && rsi < this.cfg.rsiBuyThreshold) {
      const ma = this._getVolMA();
      if (ma == null) {
        this._skip('NO_VOL_MA', { rsi });
        return;
      }
      const volRatio = candle.volume / ma;
      if (volRatio < this.volMult) {
        this._skip('VOL_LOW_CLOSE', { rsi, volRatio: volRatio.toFixed(1), need: this.volMult });
        return;
      }
      this._tryEnter({
        price: candle.close, ts: (candle.ts + 60) * 1000, rsi,
        volRatio, trigger: 'CANDLE_CLOSE',
      });
    }
  }

  _onTick(tick) {
    if (!this.started) return;
    this._resetDailyIfNeeded(tick.ts);

    const stepRsi = this.ind.getStepRSI();
    if (this.position) {
      this._checkExit(tick.price, stepRsi, tick.ts);
      return;
    }
    // intra-candle 触发
    if (stepRsi == null || this.intraTriggered) return;

    if (stepRsi < this.cfg.rsiBuyThreshold) {
      this.rsiBelowCount++;
    } else {
      this.rsiBelowCount = 0;
      return;
    }
    if (this.rsiBelowCount < this.cfg.rsiDebounceTicks) return;

    const candleStart = this.agg.getCurrentCandleStartTs();
    const elapsed = tick.ts - candleStart;
    if (elapsed < this.cfg.minIntraCandleSecs) return;

    const ma = this._getVolMA();
    if (ma == null) return;
    const cur = this.agg.getCurrentCandle();
    const partialVolRatio = cur.volume / ma;
    if (partialVolRatio < this.cfg.volIntraCandleMult) {
      // 不打 SKIP 日志,intra 阶段太频繁,只记 closed-bar SKIP
      return;
    }

    // 新增:深 wick 形态过滤
    // 当前 candle 必须已经形成 >= 8% 的下影
    // (open-low)/open >= wickDepthMin 才允许 intra 触发
    // 这能把"还在阴跌"和"已经被一棒砸下来"区分开
    const wickDepth = cur.open > 0 ? (cur.open - cur.low) / cur.open : 0;
    if (wickDepth < this.cfg.wickDepthMin) {
      // 静默,intra 阶段不打日志
      return;
    }

    this._tryEnter({
      price: tick.price, ts: tick.ts * 1000, rsi: stepRsi,
      volRatio: partialVolRatio, wickDepth, trigger: 'INTRA_CANDLE',
    });
    this.intraTriggered = true;
  }

  _tryEnter({ price, ts, rsi, volRatio, wickDepth, trigger }) {
    if (ts - this.lastExitTs < this.cfg.cooldownAfterExitSec * 1000) {
      this._skip('COOLDOWN', { sinceExit: ((ts-this.lastExitTs)/1000).toFixed(0)+'s' });
      return;
    }
    if (this.dailyTradeCount >= this.cfg.maxDailyTradesPerToken) {
      this._skip('DAILY_LIMIT', { count: this.dailyTradeCount });
      return;
    }
    const ageMin = (ts - this.tokenMeta.listedAt) / 60_000;
    if (ageMin < this.cfg.minTokenAgeMinutes) {
      this._skip('TOO_YOUNG', { ageMin: ageMin.toFixed(1) });
      return;
    }

    this.position = {
      entryPrice: price, entryTs: ts, entryRsi: rsi,
      peakPrice: price,
      hardStopPrice: price * (1 + this.cfg.stopLossPct),
      timeStopTs: ts + this.cfg.maxHoldMinutes * 60_000,
      trigger,
      // A2: STOP_LOSS 2-tick 确认计数
      stopLossViolationCount: 0,
    };
    this.dailyTradeCount++;
    this.rsiBelowCount = 0;

    // reason 用动态阈值,加 wick 信息(intra 触发时)
    const wickStr = wickDepth != null ? ` + Wick${(wickDepth*100).toFixed(1)}%` : '';
    const threshStr = `RSI<${this.cfg.rsiBuyThreshold}(${rsi.toFixed(1)})`;
    this.emit('BUY', {
      address: this.tokenMeta.address,
      symbol: this.tokenMeta.symbol,
      price, ts, rsi,
      reason: `${threshStr} + Vol×${volRatio.toFixed(1)}${wickStr} [${trigger}]`,
    });
  }

  _checkExit(price, stepRsi, ts) {
    const p = this.position;
    if (!p) return;
    if (price > p.peakPrice) p.peakPrice = price;

    let exit = null;

    // 1. STOP_LOSS:A2 - 2-tick 确认(防 MEV 假成交单 tick 假象)
    //    连续 2 个 tick 都低于止损价才触发
    if (price <= p.hardStopPrice) {
      p.stopLossViolationCount++;
      if (p.stopLossViolationCount >= 2) {
        exit = { reason: 'STOP_LOSS', price };
      }
      // 注意:即使第 1 个 tick 触发,后面 tick 价格回升上来不重置计数
      // (假成交结束就回升,真崩盘会持续) — 设计选择是宽松的累计计数
    } else {
      // 价格回到止损线之上,清零计数(只惩罚"持续在止损线下方")
      p.stopLossViolationCount = 0;
    }

    // 2. TIME_STOP
    if (!exit && ts * 1000 >= p.timeStopTs) {
      exit = { reason: 'TIME_STOP', price };
    }

    // 3. RSI_PANIC(80) - 极端值用 stepRSI(intra-candle),反应快
    if (!exit && stepRsi != null && stepRsi >= this.cfg.rsiSellHard) {
      exit = { reason: `RSI_PANIC(${stepRsi.toFixed(1)}>=80)`, price };
    }

    // 4. RSI_CROSS_DOWN_70:A1 - 改用 closed-bar RSI(更稳,不会被 intra-candle 假突破打出场)
    //    注意:只在每分钟 candle 关闭时才会有新的 closed-bar RSI 值
    //    这里在 tick 处理里检查,但只看是否"刚刚发生过"closed-bar 下穿
    if (!exit) {
      if (this._closedBarCrossedDown70()) {
        const closedRsi = this.ind.getRSI();
        const prevClosedRsi = this.ind.getPrevRSI();
        exit = {
          reason: `RSI_CROSS_DOWN_70(${prevClosedRsi.toFixed(1)}→${closedRsi.toFixed(1)})`,
          price,
        };
      }
    }

    if (exit) {
      this.emit('SELL', {
        address: this.tokenMeta.address,
        symbol: this.tokenMeta.symbol,
        price: exit.price,
        ts: ts * 1000,
        reason: exit.reason,
        entryPrice: p.entryPrice,
      });
      this.position = null;
      this.lastExitTs = ts * 1000;
    }
  }

  /**
   * A1: 检查 closed-bar RSI 是否刚刚发生下穿 70
   * 用一个内部状态变量 _lastCheckedClosedRsiTs 防止重复触发
   */
  _closedBarCrossedDown70() {
    const closedRsi = this.ind.getRSI();
    const prevClosedRsi = this.ind.getPrevRSI();
    if (closedRsi == null || prevClosedRsi == null) return false;

    const crossed = prevClosedRsi >= this.cfg.rsiSellCrossDown
                 && closedRsi < this.cfg.rsiSellCrossDown;
    if (!crossed) return false;

    // 用最新 closed candle 的 ts 作为标识,确保同一根 candle 只触发一次
    const lastClosedCandleTs = this._getLastClosedCandleTs();
    if (lastClosedCandleTs === this._lastCrossedDownCandleTs) return false;
    this._lastCrossedDownCandleTs = lastClosedCandleTs;
    return true;
  }

  _getLastClosedCandleTs() {
    const completed = this.agg.getCompletedCandles(1);
    return completed.length > 0 ? completed[0].ts : null;
  }

  // ============================================================
  _getVolMA() {
    const valid = this.completedVolumes.filter(v => v > 0);
    if (valid.length < this.cfg.volMaWindow) return null;
    const recent = valid.slice(-this.cfg.volMaWindow);
    return recent.reduce((a,b)=>a+b,0) / recent.length;
  }

  _getVolMultByFdv(fdv) {
    if (!fdv) return 5;
    for (const tier of this.cfg.volMultByFdv) {
      if (fdv < tier.maxFdv) return tier.mult;
    }
    return 3;
  }

  _resetDailyIfNeeded(ts) {
    const todayStart = this._bjtTodayStart(ts);
    if (todayStart > this.dailyResetTs) {
      this.dailyTradeCount = 0;
      this.dailyResetTs = todayStart;
    }
  }

  _bjtTodayStart(ts) {
    const t = ts || Math.floor(Date.now() / 1000);
    const bjt = t + 8 * 3600;
    return Math.floor(bjt / 86400) * 86400 - 8 * 3600;
  }

  _skip(type, info) {
    this.emit('SKIP', {
      address: this.tokenMeta.address,
      symbol: this.tokenMeta.symbol,
      type, info,
    });
  }
}

module.exports = WickReversalSignal;
