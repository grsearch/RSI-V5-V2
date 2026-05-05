/**
 * DailyReporter
 * ==============
 * BJT 每天 08:00 触发,生成前 24 小时的完整报告
 * 输出 JSON + CSV 到 data/reports/
 */
const fs = require('fs');
const path = require('path');

class DailyReporter {
  constructor(opts) {
    this.tradeLogger = opts.tradeLogger;
    this.tokenPool = opts.tokenPool;
    this.outputDir = opts.outputDir;
    this.bjtHour = opts.bjtHour || 8;
    this.timer = null;
  }

  start() {
    this._scheduleNext();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  _scheduleNext() {
    const now = new Date();
    // 计算下一个 BJT 8:00 的本地时间
    // BJT = UTC+8;先转 UTC 时间
    const utcNow = now.getTime();
    const bjtNow = new Date(utcNow + 8 * 3600 * 1000);
    const bjtHour = bjtNow.getUTCHours();
    const bjtMin = bjtNow.getUTCMinutes();

    // 计算今天 BJT 8:00 对应的 UTC 时间戳
    const bjtTodayTarget = new Date(bjtNow);
    bjtTodayTarget.setUTCHours(this.bjtHour, 0, 0, 0);
    let targetUtc = bjtTodayTarget.getTime() - 8 * 3600 * 1000;

    if (targetUtc <= utcNow) {
      // 今天的 8:00 已过,推迟到明天
      targetUtc += 24 * 3600 * 1000;
    }

    const delay = targetUtc - utcNow;
    const next = new Date(targetUtc);
    console.log(`[REPORTER] 下次报告: ${next.toISOString()} (${Math.round(delay/60000)} min later)`);

    this.timer = setTimeout(async () => {
      try {
        await this.generateReport();
      } catch (e) {
        console.error('[REPORTER] 生成报告失败:', e);
      }
      this._scheduleNext();
    }, delay);
  }

  /**
   * 生成报告:统计 BJT 昨日 8:00 ~ 今日 8:00 的所有交易
   */
  async generateReport(targetDate) {
    // 当前 UTC 毫秒
    const now = Date.now();
    // 转 BJT 毫秒(只用于找"BJT 当天 0 点"对应的 UTC ms)
    const bjtNow = now + 8 * 3600_000;
    // BJT 今日 0 点(UTC 毫秒形式)
    const bjtTodayStartUtc = Math.floor(bjtNow / 86400_000) * 86400_000 - 8 * 3600_000;
    // 今日 BJT 8:00 在 UTC 时间轴上的位置
    const endMs = bjtTodayStartUtc + this.bjtHour * 3600_000;
    const startMs = endMs - 24 * 3600_000;

    // 报告日期标签:用窗口结束日(BJT)
    const bjtEnd = new Date(endMs + 8 * 3600_000);
    const dateLabel = bjtEnd.toISOString().slice(0, 10);  // YYYY-MM-DD
    console.log(`[REPORTER] 生成 ${dateLabel} 报告 (${new Date(startMs).toISOString()} ~ ${new Date(endMs).toISOString()})`);

    const trades = await this.tradeLogger.getTradesInRange(startMs, endMs);
    const signals = await this.tradeLogger.getSignalsInRange(startMs, endMs);

    // ===== 总体统计 =====
    const completedTrades = trades.filter(t => t.exitTs);
    const wins = completedTrades.filter(t => t.pnlSol > 0);
    const losses = completedTrades.filter(t => t.pnlSol <= 0);
    const totalPnlSol = completedTrades.reduce((s, t) => s + (t.pnlSol || 0), 0);
    const winRate = completedTrades.length ? wins.length / completedTrades.length : 0;
    const avgWinPct = wins.length ? wins.reduce((s,t)=>s+t.pnlPct,0) / wins.length : 0;
    const avgLossPct = losses.length ? losses.reduce((s,t)=>s+t.pnlPct,0) / losses.length : 0;
    const profitFactor = avgLossPct < 0 ? Math.abs(avgWinPct / avgLossPct) : 0;

    // ===== 按 token 分解 =====
    const byToken = {};
    for (const t of completedTrades) {
      const k = t.symbol;
      if (!byToken[k]) byToken[k] = { trades: 0, wins: 0, totalPnlSol: 0, address: t.address };
      byToken[k].trades++;
      if (t.pnlSol > 0) byToken[k].wins++;
      byToken[k].totalPnlSol += t.pnlSol || 0;
    }
    const tokenStats = Object.entries(byToken).map(([symbol, s]) => ({
      symbol, ...s, winRate: s.wins / s.trades,
    })).sort((a, b) => b.totalPnlSol - a.totalPnlSol);

    // ===== 出场原因分布 =====
    const byReason = {};
    for (const t of completedTrades) {
      const r = (t.exitReason || 'UNKNOWN').split('(')[0];
      if (!byReason[r]) byReason[r] = { count: 0, totalPnlSol: 0, totalPnlPct: 0 };
      byReason[r].count++;
      byReason[r].totalPnlSol += t.pnlSol || 0;
      byReason[r].totalPnlPct += t.pnlPct || 0;
    }
    const reasonStats = Object.entries(byReason).map(([reason, s]) => ({
      reason,
      count: s.count,
      pct: s.count / (completedTrades.length || 1),
      avgPnlSol: s.totalPnlSol / s.count,
      avgPnlPct: s.totalPnlPct / s.count,
      totalPnlSol: s.totalPnlSol,
    })).sort((a, b) => b.count - a.count);

    // ===== 信号 SKIP 分布(看哪些被过滤掉)=====
    const skipReasons = {};
    for (const s of signals.filter(x => x.type === 'SKIP')) {
      const k = s.skipType || s.type;
      skipReasons[k] = (skipReasons[k] || 0) + 1;
    }

    // ===== 持仓时长分布 =====
    const holdMinutes = completedTrades.map(t => t.holdMinutes || 0).filter(x => x > 0);
    holdMinutes.sort((a,b)=>a-b);
    const median = holdMinutes.length ? holdMinutes[Math.floor(holdMinutes.length/2)] : 0;
    const avgHold = holdMinutes.length ? holdMinutes.reduce((a,b)=>a+b,0)/holdMinutes.length : 0;

    const report = {
      date: dateLabel,
      periodStart: new Date(startMs).toISOString(),
      periodEnd: new Date(endMs).toISOString(),
      summary: {
        totalTrades: completedTrades.length,
        wins: wins.length,
        losses: losses.length,
        winRate,
        totalPnlSol,
        avgWinPct,
        avgLossPct,
        profitFactor,
        avgHoldMinutes: avgHold,
        medianHoldMinutes: median,
        tokensTraded: Object.keys(byToken).length,
      },
      tokenStats,
      reasonStats,
      skipReasons,
      trades: completedTrades,  // 全部交易明细
      tokenPoolSnapshot: this.tokenPool.getAll().map(t => ({
        symbol: t.symbol, address: t.address, fdv: t.fdv, lpUsd: t.lpUsd,
      })),
    };

    // 写 JSON
    fs.mkdirSync(this.outputDir, { recursive: true });
    const jsonPath = path.join(this.outputDir, `${dateLabel}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

    // 写 CSV(交易明细)
    const csvPath = path.join(this.outputDir, `${dateLabel}.csv`);
    const csvHeader = 'symbol,address,entry_ts,entry_price,entry_sol,entry_reason,entry_rsi,exit_ts,exit_price,exit_sol,exit_reason,pnl_sol,pnl_pct,hold_min\n';
    const csvRows = completedTrades.map(t => {
      return [
        t.symbol, t.address,
        new Date(t.entryTs).toISOString(),
        t.entryPrice, t.entrySol,
        `"${(t.entryReason||'').replace(/"/g,'""')}"`,
        t.entryRsi,
        new Date(t.exitTs).toISOString(),
        t.exitPrice, t.exitSol,
        `"${(t.exitReason||'').replace(/"/g,'""')}"`,
        t.pnlSol, (t.pnlPct*100).toFixed(2)+'%',
        t.holdMinutes?.toFixed(1) || '',
      ].join(',');
    }).join('\n');
    fs.writeFileSync(csvPath, csvHeader + csvRows);

    console.log(`[REPORTER] ✓ ${dateLabel} 报告已生成`);
    console.log(`  总交易: ${completedTrades.length} | 胜率: ${(winRate*100).toFixed(1)}% | PnL: ${totalPnlSol.toFixed(4)} SOL`);
    console.log(`  → ${jsonPath}`);
    console.log(`  → ${csvPath}`);

    return report;
  }
}

module.exports = DailyReporter;
