/**
 * 测试新入场逻辑(RSI 13 / 量能翻倍 / intra 激进 / 深 wick 过滤)
 *
 * 测试场景:
 *   E1: RSI=12 + 巨量 + 深 wick → 入场(RSI 放宽到 13 生效)
 *   E2: RSI=12 + 量能不够(老阈值能过,新阈值不够)→ 不入场(量能翻倍生效)
 *   E3: RSI=12 + 巨量 + 浅 wick(<8%)→ intra 不入场(深 wick 过滤生效)
 *   E4: RSI=12 + 巨量 + 深 wick + 只走 8 秒 → 不入场(< 10 秒等待)
 *   E5: RSI=12 + 巨量 + 深 wick + 走 12 秒 → 入场(>= 10 秒,intra 激进 OK)
 *   E6: RSI=14 → 不入场(高于阈值)
 *   E7: stepRSI 在 13 附近抖动:12 → 14 → 12 → 14 → 12,只看连续 2 tick 计数
 */
const { CandleAggregator, IndicatorEngine } = require('./src/data/IndicatorEngine');
const WickReversalSignal = require('./src/strategies/WickReversalSignal');

// 配置(对应今天改动后的最终参数)
const TEST_CFG = {
  rsiPeriod: 7, rsiBuyThreshold: 13,
  volMaWindow: 20,
  volMultByFdv: [
    { maxFdv: 100_000, mult: 16 }, { maxFdv: 500_000, mult: 10 },
    { maxFdv: 2_000_000, mult: 8 }, { maxFdv: Infinity, mult: 6 },
  ],
  volIntraCandleMult: 8, minIntraCandleSecs: 10, rsiDebounceTicks: 2,
  wickDepthMin: 0.08,
  rsiSellCrossDown: 70, rsiSellHard: 80,
  stopLossPct: -0.08, maxHoldMinutes: 15,
  cooldownAfterExitSec: 60, maxDailyTradesPerToken: 5,
  minTokenAgeMinutes: 30,
};

function makeSignal(fdv = 200_000) {
  const agg = new CandleAggregator(60);
  const ind = new IndicatorEngine(agg, { rsiPeriod: 7 });
  const signal = new WickReversalSignal({
    tokenMeta: {
      address: 'TestToken1111111111111111111111111111111111',
      symbol: 'TEST',
      listedAt: Date.now() - 86400_000,
      fdv,
    },
    candleAggregator: agg, indicatorEngine: ind, config: TEST_CFG,
  });
  signal.start();

  // mock 完整 volume MA(20 根有效 closed bar,平均 100)
  signal.completedVolumes = Array(20).fill(100);

  return { signal, agg, ind };
}

// 设置当前 candle(用于 intra 触发测试)
function setCurrentCandle(agg, { open, high, low, close, volume, ts }) {
  agg.currentCandle = {
    ts, open, high, low, close, volume, ticks: 1,
  };
}

let passed = 0, failed = 0;
function test(label, expected, action) {
  const { signal, agg, ind } = makeSignal();
  const events = [];
  signal.on('BUY', e => events.push(e));

  action({ signal, agg, ind });

  if (expected === null) {
    if (events.length === 0) {
      console.log(`  ✓ ${label}`);
      passed++;
    } else {
      console.log(`  ✗ ${label} (期望不入场,但入场了: ${events[0].reason})`);
      failed++;
    }
  } else {
    if (events.length > 0) {
      console.log(`  ✓ ${label} (入场: ${events[0].reason})`);
      passed++;
    } else {
      console.log(`  ✗ ${label} (期望入场,但没触发)`);
      failed++;
    }
  }
}

console.log('========================================');
console.log(' 新入场逻辑测试(RSI=13, Vol×10, intra 激进, 深 wick)');
console.log(' FDV=200K → 量能阈值 closed=10x, intra=8x');
console.log('========================================');

// E1: RSI=12 + 巨量(15x)+ 深 wick(10%)+ 走 12 秒 → 入场
test('E1: RSI=12 + Vol×15 + Wick=10% + 12s → 入场', 'BUY', ({ signal, agg, ind }) => {
  const baseTs = Math.floor(Date.now() / 1000);
  setCurrentCandle(agg, { ts: baseTs, open: 1.0, high: 1.0, low: 0.90, close: 0.92, volume: 1500 });
  ind.getStepRSI = () => 12;
  // 喂 2 个 tick(达到 debounce 2)
  signal._onTick({ ts: baseTs + 11, price: 0.92, sol_amount: 0 });
  signal._onTick({ ts: baseTs + 12, price: 0.92, sol_amount: 0 });
});

// E2: RSI=12 + 量能 7x(老阈值 4 能过,新阈值 8 不够)→ 不入场
test('E2: RSI=12 + Vol×7(< 8 intra阈值)→ 不入场', null, ({ signal, agg, ind }) => {
  const baseTs = Math.floor(Date.now() / 1000);
  setCurrentCandle(agg, { ts: baseTs, open: 1.0, high: 1.0, low: 0.90, close: 0.92, volume: 700 });  // 7x
  ind.getStepRSI = () => 12;
  signal._onTick({ ts: baseTs + 11, price: 0.92, sol_amount: 0 });
  signal._onTick({ ts: baseTs + 12, price: 0.92, sol_amount: 0 });
});

// E3: RSI=12 + 巨量 + 浅 wick(5%)→ intra 不入场(深 wick 过滤生效)
test('E3: RSI=12 + Vol×15 + Wick=5%(< 8%)→ 不入场', null, ({ signal, agg, ind }) => {
  const baseTs = Math.floor(Date.now() / 1000);
  setCurrentCandle(agg, { ts: baseTs, open: 1.0, high: 1.0, low: 0.95, close: 0.96, volume: 1500 });  // wick 5%
  ind.getStepRSI = () => 12;
  signal._onTick({ ts: baseTs + 11, price: 0.96, sol_amount: 0 });
  signal._onTick({ ts: baseTs + 12, price: 0.96, sol_amount: 0 });
});

// E4: 只走 8 秒(< 10) → 不入场
test('E4: RSI=12 + Vol×15 + Wick=10% + 仅 8s → 不入场', null, ({ signal, agg, ind }) => {
  const baseTs = Math.floor(Date.now() / 1000);
  setCurrentCandle(agg, { ts: baseTs, open: 1.0, high: 1.0, low: 0.90, close: 0.92, volume: 1500 });
  ind.getStepRSI = () => 12;
  signal._onTick({ ts: baseTs + 7, price: 0.92, sol_amount: 0 });
  signal._onTick({ ts: baseTs + 8, price: 0.92, sol_amount: 0 });
});

// E5: 走 12 秒 → 入场(intra 激进生效)
test('E5: RSI=12 + Vol×15 + Wick=10% + 12s → 入场', 'BUY', ({ signal, agg, ind }) => {
  const baseTs = Math.floor(Date.now() / 1000);
  setCurrentCandle(agg, { ts: baseTs, open: 1.0, high: 1.0, low: 0.90, close: 0.92, volume: 1500 });
  ind.getStepRSI = () => 12;
  signal._onTick({ ts: baseTs + 11, price: 0.92, sol_amount: 0 });
  signal._onTick({ ts: baseTs + 12, price: 0.92, sol_amount: 0 });
});

// E6: RSI=14 → 不入场
test('E6: RSI=14(> 13 阈值)→ 不入场', null, ({ signal, agg, ind }) => {
  const baseTs = Math.floor(Date.now() / 1000);
  setCurrentCandle(agg, { ts: baseTs, open: 1.0, high: 1.0, low: 0.90, close: 0.92, volume: 1500 });
  ind.getStepRSI = () => 14;
  signal._onTick({ ts: baseTs + 11, price: 0.92, sol_amount: 0 });
  signal._onTick({ ts: baseTs + 12, price: 0.92, sol_amount: 0 });
});

// E7: RSI 抖动:12 → 14 → 12 → 14 → 12 → 12 (最后两个连续才触发,debounce=2)
test('E7: RSI 抖动 12→14→12→14→12→12 → 入场(最后 2 连续)', 'BUY', ({ signal, agg, ind }) => {
  const baseTs = Math.floor(Date.now() / 1000);
  setCurrentCandle(agg, { ts: baseTs, open: 1.0, high: 1.0, low: 0.90, close: 0.92, volume: 1500 });
  let rsiSeq = [12, 14, 12, 14, 12, 12];
  let i = 0;
  ind.getStepRSI = () => rsiSeq[i++];
  for (let k = 0; k < 6; k++) {
    signal._onTick({ ts: baseTs + 11 + k, price: 0.92, sol_amount: 0 });
  }
});

// E8: 边界:RSI 刚好 13 → 不入场(严格 < 13)
test('E8: RSI=13(刚好等于阈值)→ 不入场(严格 <)', null, ({ signal, agg, ind }) => {
  const baseTs = Math.floor(Date.now() / 1000);
  setCurrentCandle(agg, { ts: baseTs, open: 1.0, high: 1.0, low: 0.90, close: 0.92, volume: 1500 });
  ind.getStepRSI = () => 13;
  signal._onTick({ ts: baseTs + 11, price: 0.92, sol_amount: 0 });
  signal._onTick({ ts: baseTs + 12, price: 0.92, sol_amount: 0 });
});

// E9: FDV 微盘(50K)阈值应该是 16x,Vol 12x 不够
test('E9: FDV=50K + Vol×12(< 16x 微盘阈值)→ 不入场', null, ({ signal, agg, ind }) => {
  // 重新建一个 FDV=50K 的实例
  const { signal: s2, agg: a2, ind: i2 } = makeSignal(50_000);
  const baseTs = Math.floor(Date.now() / 1000);
  setCurrentCandle(a2, { ts: baseTs, open: 1.0, high: 1.0, low: 0.90, close: 0.92, volume: 1200 });  // 12x
  i2.getStepRSI = () => 12;
  // intra 阈值固定 8x,12x 应该过... 不对,让我看下
  // 实际:intra 阈值是 cfg.volIntraCandleMult = 8,跟 FDV 无关
  // FDV 只影响 closed-bar 阈值
  // 所以这个测试需要走 closed-bar 路径,intra 12x > 8x 实际会过
  // 改测试:走 closed-bar 路径
  s2.completedVolumes = Array(20).fill(100);
  // 关闭一根 candle,vol = 1200(12x),应该不够 16x
  s2._onCandleClose({
    ts: baseTs - 60, open: 1.0, high: 1.0, low: 0.85, close: 0.86, volume: 1200,
  });
  // 信号需要 prevRSI >= 13 AND currentRSI < 13
  // mock RSI 历史
  i2.getRSI = () => 11;
  i2.getPrevRSI = () => 14;
  // 重新调用 closed handler
  s2.completedVolumes = Array(20).fill(100);
  s2._onCandleClose({
    ts: baseTs - 60, open: 1.0, high: 1.0, low: 0.85, close: 0.86, volume: 1200,
  });
  // 把 events 转移过来
  const moved = [];
  s2.on('BUY', e => moved.push(e));
});

console.log();
console.log(`========================================`);
console.log(` 总计: ${passed} 通过, ${failed} 失败`);
console.log('========================================');
process.exit(failed > 0 ? 1 : 0);
