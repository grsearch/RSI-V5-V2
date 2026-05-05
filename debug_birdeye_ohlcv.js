#!/usr/bin/env node
/**
 * Birdeye OHLCV 调试工具
 * ========================
 * 用法:
 *   BIRDEYE_API_KEY=xxx node debug_birdeye_ohlcv.js <TOKEN_ADDRESS>
 *
 * 例如:
 *   BIRDEYE_API_KEY=xxx node debug_birdeye_ohlcv.js BWJ7zJauzatao4FsBnGdVsqdBi3k5NbgSY62noZApump
 *
 * 输出:
 *   - 原始响应字段(让你看清楚字段名)
 *   - v3 vs v1 endpoint 对比
 *   - 最近 10 根 candle 的 OHLCV
 *   - volume 统计:有效根数 / 平均值 / 最大值
 */

const address = process.argv[2];
if (!address) {
  console.error('Usage: BIRDEYE_API_KEY=xxx node debug_birdeye_ohlcv.js <TOKEN_ADDRESS>');
  process.exit(1);
}
const apiKey = process.env.BIRDEYE_API_KEY;
if (!apiKey) {
  console.error('请设置 BIRDEYE_API_KEY 环境变量');
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const timeFrom = now - 60 * 60;  // 最近 1 小时
const timeTo = now;

async function fetchAndAnalyze(url, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(` ${label}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`URL: ${url}`);

  try {
    const res = await fetch(url, {
      headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana' },
    });
    console.log(`HTTP: ${res.status}`);
    if (!res.ok) {
      const text = await res.text();
      console.log(`错误响应: ${text.slice(0, 200)}`);
      return null;
    }
    const json = await res.json();
    console.log(`success: ${json.success}`);
    const items = json.data?.items || [];
    console.log(`items 数量: ${items.length}`);

    if (items.length === 0) {
      console.log('⚠️  没有数据,这个 token 可能 Birdeye 不索引或时间范围太近');
      return items;
    }

    // 显示第一条的所有字段
    console.log(`\n第 1 条原始字段:`);
    console.log(JSON.stringify(items[0], null, 2));

    // 显示最近 10 条
    console.log(`\n最近 10 条 OHLCV:`);
    console.log('UnixTime           Time(BJT)    O          H          L          C          V          V_USD');
    console.log('-'.repeat(120));
    for (const it of items.slice(-10)) {
      const date = new Date(it.unixTime * 1000);
      const bjt = new Date(date.getTime() + 8 * 3600_000);
      const timeStr = bjt.toISOString().slice(11, 19);
      console.log(
        `${it.unixTime}   ${timeStr}   ` +
        `${(Number(it.o) || 0).toExponential(4)}  ` +
        `${(Number(it.h) || 0).toExponential(4)}  ` +
        `${(Number(it.l) || 0).toExponential(4)}  ` +
        `${(Number(it.c) || 0).toExponential(4)}  ` +
        `${(Number(it.v) || 0).toFixed(2).padStart(10)}  ` +
        `${(Number(it.v_usd) || 0).toFixed(2).padStart(10)}`
      );
    }

    // volume 统计
    const vs = items.map(it => Number(it.v) || 0).filter(v => v > 0);
    const vusds = items.map(it => Number(it.v_usd) || 0).filter(v => v > 0);
    console.log(`\nVolume 统计:`);
    console.log(`  v 字段:    ${vs.length}/${items.length} 根有效, avg=${vs.length ? (vs.reduce((a,b)=>a+b,0)/vs.length).toFixed(4) : 'N/A'}`);
    console.log(`  v_usd 字段: ${vusds.length}/${items.length} 根有效, avg=${vusds.length ? (vusds.reduce((a,b)=>a+b,0)/vusds.length).toFixed(2) : 'N/A'}`);

    return items;
  } catch (e) {
    console.error('请求失败:', e.message);
    return null;
  }
}

(async () => {
  console.log(`Token: ${address}`);
  console.log(`时间范围: ${new Date(timeFrom*1000).toISOString()} ~ ${new Date(timeTo*1000).toISOString()}`);

  // V3
  await fetchAndAnalyze(
    `https://public-api.birdeye.so/defi/v3/ohlcv?address=${address}&type=1m&currency=usd&time_from=${timeFrom}&time_to=${timeTo}`,
    'OHLCV V3 (USD)'
  );

  // V1
  await fetchAndAnalyze(
    `https://public-api.birdeye.so/defi/ohlcv?address=${address}&type=1m&time_from=${timeFrom}&time_to=${timeTo}`,
    'OHLCV V1'
  );

  console.log(`\n${'='.repeat(60)}`);
  console.log(' 结论');
  console.log(`${'='.repeat(60)}`);
  console.log('如果两个 endpoint 都返回 v=0 或 v_usd=0:');
  console.log('  → 这个 token Birdeye 没有 volume 索引');
  console.log('  → 必须用 Helius 直接订阅 swap 事件自己聚合');
  console.log('如果 v3 有 v_usd 但 v1 没有:');
  console.log('  → HistoricalCandleLoader 用 v3,代码已经修复');
  console.log('如果 v3/v1 数据都正常:');
  console.log('  → 说明你之前 dashboard 的 volRatio=0 是别的原因');
  console.log('     很可能是 Helius tick 流没接好, partial volume 永远是 0');
})();
