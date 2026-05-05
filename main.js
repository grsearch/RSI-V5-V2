/**
 * RSI<10 + Volume V5 主入口
 * ===========================
 * 启动:  node main.js
 * DRY_RUN: DRY_RUN=1 node main.js
 *
 * 默认端口: dashboard 3001
 */
const path = require('path');
const fs = require('fs');
const TokenPoolManager = require('./src/data/TokenPoolManager');
const DashboardServer = require('./src/dashboard/DashboardServer');
const DailyReporter = require('./src/reports/DailyReporter');
const TradeLogger = require('./src/data/TradeLogger');
const HeliusClient = require('./src/data/HeliusClient');
const StrategyOrchestrator = require('./src/strategies/StrategyOrchestrator');
const { loadConfig } = require('./src/config');

async function main() {
  const config = loadConfig();
  console.log('========================================');
  console.log(` RSI<${config.strategy.rsiBuyThreshold} + Volume V5`);
  console.log(`  DRY_RUN: ${config.dryRun ? 'YES' : 'NO (LIVE!)'}`);
  console.log(`  Dashboard: http://localhost:${config.dashboardPort}`);
  console.log(`  Daily report: ${config.dailyReportTime}`);
  console.log(`  Vol thresholds: ${config.strategy.volMultByFdv.map(t =>
    `<${t.maxFdv === Infinity ? '∞' : (t.maxFdv/1000)+'K'}:${t.mult}x`).join(' / ')}`);
  console.log(`  Wick depth min: ${(config.strategy.wickDepthMin*100).toFixed(0)}%`);
  console.log('========================================\n');

  // 数据持久化
  const tradeLogger = new TradeLogger({
    dataDir: path.join(__dirname, 'data'),
    logsDir: path.join(__dirname, 'logs'),
  });

  // Helius 数据源
  const helius = new HeliusClient({
    apiKey: config.heliusApiKey,
    endpoint: config.heliusEndpoint,
    region: config.heliusRegion,
  });

  // Token 池管理
  const tokenPool = new TokenPoolManager({
    minFdv: config.minFdv,           // 默认 30000
    minLpUsd: config.minLpUsd,       // 默认 10000
    refreshIntervalMs: 30 * 1000,    // 每 30 秒检查一次 FDV/LP
    onTokenRemoved: async (token, reason) => {
      console.log(`[POOL] 移除 ${token.symbol}: ${reason}`);
      // 移除前检查持仓,有持仓先卖
      await orchestrator.forceClosePosition(token.address, 'POOL_REMOVE_' + reason);
    },
  });

  // 策略协调器(管理每个 token 的 signal 实例)
  const orchestrator = new StrategyOrchestrator({
    helius,
    tokenPool,
    tradeLogger,
    config,
    dryRun: config.dryRun,
  });

  // Dashboard
  const dashboard = new DashboardServer({
    port: config.dashboardPort,
    tokenPool,
    orchestrator,
    tradeLogger,
    onAddToken: async (req) => {
      // 来自手动 UI 或 webhook
      return await tokenPool.addToken(req);
    },
  });

  // 每日报告(BJT 8AM)
  const reporter = new DailyReporter({
    tradeLogger,
    tokenPool,
    outputDir: path.join(__dirname, 'data', 'reports'),
    bjtHour: config.dailyReportHour,  // 默认 8
  });

  // 启动顺序
  await tradeLogger.init();
  await tokenPool.init();
  await orchestrator.init();
  await dashboard.start();
  reporter.start();

  // 优雅关停
  process.on('SIGINT', async () => {
    console.log('\n[SHUTDOWN] 关闭中...');
    await orchestrator.shutdownAll();   // 平掉所有持仓
    await dashboard.stop();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
