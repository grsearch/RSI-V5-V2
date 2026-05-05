/**
 * 测试 A1 (closed-bar RSI_CROSS_DOWN_70) + A2 (STOP_LOSS 2-tick 确认)
 *
 * 测试场景:
 *   T1: 单 tick 假成交触发止损线 → 不应该出场
 *   T2: 连续 2 tick 都低于止损线 → 应该出场
 *   T3: stepRSI 反复跨越 70(假突破)→ 不应该被打出场(A1 改用 closed-bar 后)
 *   T4: closed-bar RSI 真的下穿 70 → 出场
 */
const { CandleAggregator, IndicatorEngine } = require('./src/data/IndicatorEngine');
const WickReversalSignal = require('./src/strategies/WickReversalSignal');

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
    candleAggregator: agg,
    indicatorEngine: ind,
    config: {
      rsiPeriod: 7, rsiBuyThreshold: 10,
      volMaWindow: 20,
      volMultByFdv: [
        { maxFdv: 100_000, mult: 8 }, { maxFdv: 500_000, mult: 5 },
        { maxFdv: 2_000_000, mult: 4 }, { maxFdv: Infinity, mult: 3 },
      ],
      volIntraCandleMult: 4, minIntraCandleSecs: 20, rsiDebounceTicks: 3,
      rsiSellCrossDown: 70, rsiSellHard: 80,
      stopLossPct: -0.08, maxHoldMinutes: 15,
      cooldownAfterExitSec: 60, maxDailyTradesPerToken: 5,
      minTokenAgeMinutes: 30,
    },
  });
  signal.start();
  return { signal, agg, ind };
}

// 手动注入持仓状态(绕过入场逻辑,只测出场)
function injectPosition(signal, entryPrice, ts) {
  signal.position = {
    entryPrice, entryTs: ts * 1000,
    entryRsi: 8,
    peakPrice: entryPrice,
    hardStopPrice: entryPrice * 0.92,  // -8%
    timeStopTs: ts * 1000 + 15 * 60_000,
    trigger: 'TEST',
    stopLossViolationCount: 0,
  };
}

let passed = 0, failed = 0;
function assertExit(signal, expected, label) {
  const events = [];
  signal.removeAllListeners('SELL');
  signal.on('SELL', e => events.push(e));
  return {
    after: (action) => {
      action();
      if (expected === null) {
        if (events.length === 0) {
          console.log(`  ✓ ${label} (无出场,符合预期)`);
          passed++;
        } else {
          console.log(`  ✗ ${label} (期望不出场,但触发了: ${events[0].reason})`);
          failed++;
        }
      } else {
        if (events.length > 0 && events[0].reason.startsWith(expected)) {
          console.log(`  ✓ ${label} (出场: ${events[0].reason})`);
          passed++;
        } else {
          console.log(`  ✗ ${label} (期望 ${expected},实际 ${events[0]?.reason || '无'})`);
          failed++;
        }
      }
      return events;
    },
  };
}

// ============================================================
console.log('========================================');
console.log(' A2: STOP_LOSS 2-tick 确认测试');
console.log('========================================');

// T1: 单 tick 假成交触发止损线后回升,不应出场
{
  const { signal } = makeSignal();
  const baseTs = Math.floor(Date.now() / 1000);
  injectPosition(signal, 1.0, baseTs);

  assertExit(signal, null, 'T1: 单 tick 跌破止损线后回升 → 不出场').after(() => {
    signal._checkExit(0.91, 50, baseTs + 1);  // 第 1 次跌破(< 0.92)
    signal._checkExit(0.95, 50, baseTs + 2);  // 立即回升,清零计数
  });
}

// T2: 连续 2 tick 都低于止损线,应出场
{
  const { signal } = makeSignal();
  const baseTs = Math.floor(Date.now() / 1000);
  injectPosition(signal, 1.0, baseTs);

  assertExit(signal, 'STOP_LOSS', 'T2: 连续 2 tick 跌破止损线 → 出场').after(() => {
    signal._checkExit(0.91, 50, baseTs + 1);  // 第 1 次跌破(count=1)
    signal._checkExit(0.90, 50, baseTs + 2);  // 第 2 次跌破(count=2)→ 触发
  });
}

// T3: 单 tick 跌破后,下一 tick 仍在止损线下(连续),应出场
{
  const { signal } = makeSignal();
  const baseTs = Math.floor(Date.now() / 1000);
  injectPosition(signal, 1.0, baseTs);

  assertExit(signal, 'STOP_LOSS', 'T3: 持续低于止损线 → 出场').after(() => {
    signal._checkExit(0.91, 50, baseTs + 1);
    signal._checkExit(0.85, 50, baseTs + 2);  // 还在线下,count=2
  });
}

// T4: 跌破→回升→再跌破(单次),计数清零,不出场
{
  const { signal } = makeSignal();
  const baseTs = Math.floor(Date.now() / 1000);
  injectPosition(signal, 1.0, baseTs);

  assertExit(signal, null, 'T4: 跌破→回升→单次跌破 → 不出场').after(() => {
    signal._checkExit(0.91, 50, baseTs + 1);  // count=1
    signal._checkExit(0.95, 50, baseTs + 2);  // 清零
    signal._checkExit(0.91, 50, baseTs + 3);  // count=1,但只有 1 次,不出场
  });
}

console.log();
console.log('========================================');
console.log(' A1: closed-bar RSI_CROSS_DOWN_70 测试');
console.log('========================================');

// T5: stepRSI 反复跨越 70(假突破),但 closed-bar RSI 没下穿,不应出场
{
  const { signal, ind } = makeSignal();
  const baseTs = Math.floor(Date.now() / 1000);
  injectPosition(signal, 1.0, baseTs);

  // mock indicator: closed-bar RSI 始终在 70 以上
  ind.getRSI = () => 75;
  ind.getPrevRSI = () => 73;
  ind.getStepRSI = () => 65;        // step 已经低于 70
  ind.getPrevStepRSI = () => 72;    // 上一 tick step 高于 70 — 旧逻辑会触发出场

  assertExit(signal, null, 'T5: stepRSI 跨越 70 但 closed-bar 没下穿 → 不出场').after(() => {
    signal._checkExit(1.05, 65, baseTs + 1);
  });
}

// T6: closed-bar RSI 真的下穿 70(72 → 68),应出场
{
  const { signal, agg, ind } = makeSignal();
  const baseTs = Math.floor(Date.now() / 1000);
  injectPosition(signal, 1.0, baseTs);

  // 模拟一根关闭的 candle
  agg.completedCandles = [{ ts: baseTs - 60, open: 1, high: 1.1, low: 0.95, close: 1.05, volume: 100 }];
  ind.getRSI = () => 68;
  ind.getPrevRSI = () => 72;
  ind.getStepRSI = () => 68;

  assertExit(signal, 'RSI_CROSS_DOWN_70', 'T6: closed-bar RSI 72→68 下穿 → 出场').after(() => {
    signal._checkExit(1.05, 68, baseTs + 1);
  });
}

// T7: closed-bar RSI 已经下穿过(同一根 candle),不应该重复触发
{
  const { signal, agg, ind } = makeSignal();
  const baseTs = Math.floor(Date.now() / 1000);
  injectPosition(signal, 1.0, baseTs);

  agg.completedCandles = [{ ts: baseTs - 60, open: 1, high: 1.1, low: 0.95, close: 1.05, volume: 100 }];
  ind.getRSI = () => 68;
  ind.getPrevRSI = () => 72;
  ind.getStepRSI = () => 68;

  // 第一次:触发出场
  let firstEvents = [];
  signal.on('SELL', e => firstEvents.push(e));
  signal._checkExit(1.05, 68, baseTs + 1);
  console.log(`  ${firstEvents.length === 1 ? '✓' : '✗'} T7-prep: 第一次 closed-bar 下穿应触发(${firstEvents.length} 次)`);
  if (firstEvents.length === 1) passed++; else failed++;

  // 注意:出场后 position 已清空,需要重新注入测试"同根 candle 不重复"
  injectPosition(signal, 1.0, baseTs);
  // 同一根 closed candle 还在,_lastCrossedDownCandleTs 已记录
  assertExit(signal, null, 'T7: 同一根 closed candle 不再重复触发').after(() => {
    signal._checkExit(1.05, 68, baseTs + 2);
  });
}

// T8: RSI_PANIC(stepRSI >= 80) 仍然用 stepRSI 立即触发(不变)
{
  const { signal, ind } = makeSignal();
  const baseTs = Math.floor(Date.now() / 1000);
  injectPosition(signal, 1.0, baseTs);

  ind.getRSI = () => 75;
  ind.getPrevRSI = () => 70;
  ind.getStepRSI = () => 82;  // step >= 80
  ind.getPrevStepRSI = () => 78;

  assertExit(signal, 'RSI_PANIC', 'T8: stepRSI >= 80 立即触发 RSI_PANIC').after(() => {
    signal._checkExit(1.10, 82, baseTs + 1);
  });
}

// ============================================================
console.log();
console.log('========================================');
console.log(` 总计: ${passed} 通过, ${failed} 失败`);
console.log('========================================');
process.exit(failed > 0 ? 1 : 0);
