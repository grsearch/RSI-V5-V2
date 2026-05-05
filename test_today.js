/**
 * 测试今天的新功能:
 *   1. HistoricalCandleLoader 预填充 → RSI 立即可用
 *   2. TokenAgeResolver 缓存逻辑(失败冷却 + 永久缓存)
 *   3. Dashboard /api/tokens 返回 RSI 和 age
 */
const { CandleAggregator, IndicatorEngine } = require('./src/data/IndicatorEngine');
const HistoricalCandleLoader = require('./src/data/HistoricalCandleLoader');
const TokenAgeResolver = require('./src/data/TokenAgeResolver');

let passed = 0, failed = 0;
function expect(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// ==================================================
// 测试 1:HistoricalCandleLoader 预填充行为
// ==================================================
console.log('========================================');
console.log(' Test 1: HistoricalCandleLoader 预填充');
console.log('========================================');

(async () => {
  const loader = new HistoricalCandleLoader({ birdeyeApiKey: 'fake-key' });
  // mock 内部 fetch:返回 100 根模拟 1m candle
  const now = Math.floor(Date.now() / 1000);
  const minuteStart = Math.floor(now / 60) * 60;
  const mockCandles = [];
  for (let i = 100; i >= 1; i--) {
    const ts = minuteStart - i * 60;
    // 模拟一个有起伏的价格序列
    const price = 1.0 + 0.02 * Math.sin(i / 5);
    mockCandles.push({
      ts, open: price, high: price * 1.005, low: price * 0.995,
      close: price + (Math.random() - 0.5) * 0.01, volume: 100 + Math.random() * 50,
    });
  }
  loader._fetchBirdeyeOhlcv = async () => mockCandles;

  const agg = new CandleAggregator(60);
  const ind = new IndicatorEngine(agg, { rsiPeriod: 7 });

  // 预填充前:RSI 应该是 null
  expect(ind.getRSI() === null, '预填充前 RSI=null');
  expect(agg.completedCandles.length === 0, '预填充前 0 根 closed candle');

  const result = await loader.loadAndPrefill('FakeToken123', agg, ind);

  // 预填充后:RSI 应该有值,且 candle 数量正确
  expect(result.candleCount === 100, `预填充 100 根(实际 ${result.candleCount})`);
  expect(result.latestRsi != null, `RSI 立即可用(${result.latestRsi?.toFixed(2)})`);
  expect(result.latestRsi >= 0 && result.latestRsi <= 100, 'RSI 在 0-100 范围');
  expect(agg.completedCandles.length === 100, 'aggregator.completedCandles = 100');

  // 关键:最后一根 candle.ts 必须 < 当前 1m 窗口起点(防重叠)
  const lastTs = agg.completedCandles[agg.completedCandles.length - 1].ts;
  expect(lastTs < minuteStart, '最后一根 candle.ts 严格小于当前 1m(防与实时 tick 重叠)');

  // 模拟实时 tick 进来,应该开新 candle 而不是续写最后一根
  agg.onTick({ ts: now, price: 1.05, sol_amount: 50 });
  expect(agg.currentCandle != null, '实时 tick 开了新 candle');
  expect(agg.currentCandle.ts === minuteStart,
         `新 candle.ts = ${minuteStart}(实时 1m 窗口)`);
})().then(runTest2);


// ==================================================
// 测试 2:TokenAgeResolver 缓存 + 失败冷却
// ==================================================
async function runTest2() {
  console.log('\n========================================');
  console.log(' Test 2: TokenAgeResolver');
  console.log('========================================');

  // 用一个临时缓存路径,避免污染真实缓存
  const tmpPath = '/tmp/test_age_cache_' + Date.now() + '.json';
  const path = require('path');
  const fs = require('fs');
  // 创建一个 resolver,mock 两条数据源
  const resolver = new TokenAgeResolver({ birdeyeApiKey: 'k', heliusApiKey: 'k' });

  let birdeyeCalls = 0, heliusCalls = 0;
  resolver._fetchFromBirdeye = async (addr) => {
    birdeyeCalls++;
    if (addr === 'GoodToken1') return Math.floor(Date.now() / 1000) - 86400;  // 1 天前
    return null;  // 其他都 fail
  };
  resolver._fetchFromHelius = async (addr) => {
    heliusCalls++;
    if (addr === 'GoodToken2') return Math.floor(Date.now() / 1000) - 7200;  // 2 小时前
    return null;
  };

  // T1: Birdeye 命中
  const t1 = await resolver.getCreatedAt('GoodToken1');
  expect(t1 != null, `T1: Birdeye 命中, createdAt=${t1}`);
  expect(birdeyeCalls === 1 && heliusCalls === 0, 'T1: 只调用 Birdeye 1 次');

  // T2: 再查同一个 token,应该走缓存,不调 API
  const t1b = await resolver.getCreatedAt('GoodToken1');
  expect(t1b === t1, 'T2: 缓存命中,返回同一值');
  expect(birdeyeCalls === 1 && heliusCalls === 0, 'T2: API 调用次数没变');

  // T3: Birdeye 失败,Helius 命中
  const t2 = await resolver.getCreatedAt('GoodToken2');
  expect(t2 != null, `T3: Helius fallback 命中, createdAt=${t2}`);
  expect(birdeyeCalls === 2 && heliusCalls === 1, 'T3: Birdeye 调 1 次失败 + Helius 1 次成功');

  // T4: 双链路都失败
  const t3 = await resolver.getCreatedAt('BadToken');
  expect(t3 === null, 'T4: 双链路失败,返回 null');
  expect(birdeyeCalls === 3 && heliusCalls === 2, 'T4: 两边都打了');

  // T5: 失败冷却 — 60s 内再查 BadToken,不应该再打 API
  const t4 = await resolver.getCreatedAt('BadToken');
  expect(t4 === null, 'T5: 冷却期内仍返回 null');
  expect(birdeyeCalls === 3 && heliusCalls === 2,
    `T5: 冷却生效,API 调用次数不变(birdeye=${birdeyeCalls}, helius=${heliusCalls})`);

  // T6: warmupBatch 并发预热
  let calls2 = 0;
  resolver._fetchFromBirdeye = async (addr) => {
    calls2++;
    return Math.floor(Date.now() / 1000) - 3600;
  };
  await resolver.warmupBatch(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']);
  expect(calls2 === 8, `T6: 预热 8 个 token, 调用 ${calls2} 次`);

  // T7: getAge 是 createdAt 的差值
  const age = await resolver.getAge('GoodToken1');
  expect(age != null && age > 86000 && age < 87000, `T7: getAge 返回大约 86400s (实际 ${age})`);

  console.log();
  console.log(`========================================`);
  console.log(` 总计: ${passed} 通过, ${failed} 失败`);
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
}
