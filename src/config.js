/**
 * 配置中心
 * ========
 * 所有参数从 config.json 读取,环境变量优先
 */
const fs = require('fs');
const path = require('path');

function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  return {
    // 运行模式
    dryRun: process.env.DRY_RUN === '1' || fileConfig.dryRun || false,

    // Helius
    heliusApiKey: process.env.HELIUS_API_KEY || fileConfig.heliusApiKey || '',
    heliusEndpoint: fileConfig.heliusEndpoint || 'wss://mainnet.helius-rpc.com',
    heliusRegion: fileConfig.heliusRegion || 'tokyo',

    // 钱包(实盘必须)
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY || fileConfig.walletPrivateKey || '',

    // Dashboard
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || fileConfig.dashboardPort || 3001),

    // Token 池过滤(自动移除阈值)
    minFdv: fileConfig.minFdv || 30000,           // 你要求的:FDV < 30K 移除
    minLpUsd: fileConfig.minLpUsd || 10000,       // 你要求的:LP < 10K 移除

    // 仓位
    positionSizeSol: fileConfig.positionSizeSol || 0.5,    // 单笔 SOL
    maxLpPercent: fileConfig.maxLpPercent || 0.015,        // 单笔不超过 LP 1.5%
    maxTotalExposureSol: fileConfig.maxTotalExposureSol || 5,  // 总敞口上限

    // 策略参数
    strategy: {
      rsiPeriod: 7,
      rsiBuyThreshold: 13,            // ⬆ 10 → 13 (放宽,捕捉更多机会)
      volMaWindow: 20,
      // FDV 分级量能阈值(全表翻倍,对冲 RSI 放宽带来的噪音)
      volMultByFdv: [
        { maxFdv: 100_000, mult: 16 },   // ⬆ 8 → 16
        { maxFdv: 500_000, mult: 10 },   // ⬆ 5 → 10
        { maxFdv: 2_000_000, mult: 8 },  // ⬆ 4 → 8
        { maxFdv: Infinity, mult: 6 },   // ⬆ 3 → 6
      ],
      volIntraCandleMult: 8,          // ⬆ 4 → 8 (intra 也翻倍)
      minIntraCandleSecs: 10,         // ⬇ 20 → 10 (响应更快)
      rsiDebounceTicks: 2,            // ⬇ 3 → 2 (响应更快,代价是稍微更多假信号)

      // 新增:深 wick 形态过滤(只有 candle 已形成深 wick 才允许 intra 触发)
      // 这是真针的早期信号:大单砸盘 = (open-low)/open >= 阈值
      wickDepthMin: 0.08,             // 8% 深 wick

      // 出场
      rsiSellCrossDown: 70,
      rsiSellHard: 80,
      stopLossPct: -0.08,
      maxHoldMinutes: 15,

      // Rug 防护(占位,等后续补)
      rugProtection: {
        lpDrainPct: 0.30,
        topHolderPct: 0.70,
        checkAuthority: true,
      },

      // 风控
      cooldownAfterExitSec: 60,
      maxDailyTradesPerToken: 5,
      minTokenAgeMinutes: 30,
    },

    // 每日报告
    dailyReportHour: fileConfig.dailyReportHour || 8,
    dailyReportTime: '08:00 BJT',

    // Webhook
    webhookEnabled: fileConfig.webhookEnabled !== false,
  };
}

module.exports = { loadConfig };
