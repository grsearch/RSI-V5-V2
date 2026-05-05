/**
 * TradeLogger
 * ============
 * 持久化所有买入/卖出/拒绝信号事件,写 JSONL + 每日 CSV
 * Dashboard 通过 query 读取最近 N 条
 * DailyReporter 按日期范围读取生成报告
 */
const fs = require('fs');
const path = require('path');
const { promises: fsp } = require('fs');

class TradeLogger {
  constructor(opts) {
    this.dataDir = opts.dataDir;
    this.logsDir = opts.logsDir;
    this.tradesFile = path.join(this.dataDir, 'trades.jsonl');
    this.signalsFile = path.join(this.dataDir, 'signals.jsonl');

    // 内存缓存,Dashboard 用(只缓存最近 1000 条)
    this.recentTrades = [];
    this.recentSignals = [];
  }

  async init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.logsDir, { recursive: true });
    fs.mkdirSync(path.join(this.dataDir, 'reports'), { recursive: true });

    // 加载最近 1000 条到内存
    await this._loadRecent(this.tradesFile, this.recentTrades, 1000);
    await this._loadRecent(this.signalsFile, this.recentSignals, 1000);
    console.log(`[LOGGER] 加载 ${this.recentTrades.length} 条历史交易, ${this.recentSignals.length} 条信号`);
  }

  async _loadRecent(file, buffer, n) {
    if (!fs.existsSync(file)) return;
    const content = await fsp.readFile(file, 'utf-8');
    const lines = content.trim().split('\n').slice(-n);
    for (const line of lines) {
      try { buffer.push(JSON.parse(line)); } catch (e) { /* skip */ }
    }
  }

  /**
   * 记录信号事件(BUY/SELL 触发,也包括被拒的 SKIP)
   */
  logSignal(event) {
    const rec = {
      ts: Date.now(),
      ...event,
    };
    this._appendJsonl(this.signalsFile, rec);
    this.recentSignals.push(rec);
    if (this.recentSignals.length > 1000) this.recentSignals.shift();
  }

  /**
   * 记录完整交易(包含 entry + exit + pnl)
   */
  logTrade(trade) {
    const rec = {
      ts: Date.now(),
      ...trade,
    };
    this._appendJsonl(this.tradesFile, rec);
    this.recentTrades.push(rec);
    if (this.recentTrades.length > 1000) this.recentTrades.shift();
  }

  _appendJsonl(file, rec) {
    try {
      fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    } catch (e) {
      console.error('[LOGGER] 写入失败:', e.message);
    }
  }

  // ============================================================
  // 查询 API(供 Dashboard 和 DailyReporter)
  // ============================================================

  getRecentTrades(limit = 100) {
    return this.recentTrades.slice(-limit).reverse();
  }

  getRecentSignals(limit = 100) {
    return this.recentSignals.slice(-limit).reverse();
  }

  /**
   * 按 BJT 日期范围读取交易
   * @param {Date} startDate BJT 开始
   * @param {Date} endDate   BJT 结束
   */
  async getTradesInRange(startMs, endMs) {
    if (!fs.existsSync(this.tradesFile)) return [];
    const content = await fsp.readFile(this.tradesFile, 'utf-8');
    const result = [];
    for (const line of content.trim().split('\n')) {
      try {
        const rec = JSON.parse(line);
        // 用 exitTs 判断(交易完成时间);若没 exitTs 用 entryTs;再不行用 ts
        const t = rec.exitTs || rec.entryTs || rec.ts;
        if (t >= startMs && t < endMs) result.push(rec);
      } catch (e) {}
    }
    return result;
  }

  async getSignalsInRange(startMs, endMs) {
    if (!fs.existsSync(this.signalsFile)) return [];
    const content = await fsp.readFile(this.signalsFile, 'utf-8');
    const result = [];
    for (const line of content.trim().split('\n')) {
      try {
        const rec = JSON.parse(line);
        if (rec.ts >= startMs && rec.ts < endMs) result.push(rec);
      } catch (e) {}
    }
    return result;
  }

  /**
   * 24h 统计(给 dashboard 顶部用)
   */
  get24hStats() {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const recent = this.recentTrades.filter(t => t.ts >= cutoff && t.exitTs);
    const wins = recent.filter(t => t.pnlSol > 0);
    const losses = recent.filter(t => t.pnlSol <= 0);
    const totalPnlSol = recent.reduce((s, t) => s + (t.pnlSol || 0), 0);
    const totalPnlPct = recent.length
      ? recent.reduce((s, t) => s + (t.pnlPct || 0), 0) / recent.length
      : 0;
    const avgWinPct = wins.length
      ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length
      : 0;
    const avgLossPct = losses.length
      ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length
      : 0;
    const profitFactor = avgLossPct < 0 ? Math.abs(avgWinPct / avgLossPct) : 0;

    return {
      total: recent.length,
      wins: wins.length,
      losses: losses.length,
      winRate: recent.length ? wins.length / recent.length : 0,
      totalPnlSol,
      avgPnlPct: totalPnlPct,
      avgWinPct,
      avgLossPct,
      profitFactor,
    };
  }
}

module.exports = TradeLogger;
