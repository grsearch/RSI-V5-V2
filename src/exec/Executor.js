/**
 * Executor
 * =========
 * Jupiter swap 包装
 * DRY_RUN 时只记录 + 用当前价模拟成交(扣 7% 模拟成本)
 */
class Executor {
  constructor(opts) {
    this.dryRun = opts.dryRun;
    this.walletPrivateKey = opts.walletPrivateKey;
    this.simulatedSlippage = 0.03;
    this.simulatedFee = 0.005;
  }

  async swapSolToToken({ tokenAddress, amountSol, slippageBps }) {
    if (this.dryRun) {
      // 模拟:扣 3% 滑点 + 0.5% fee → 拿到 token 数量
      // 这里需要从 quote 拿 token 价格,简化为直接返回
      return {
        ok: true,
        txSig: 'DRY_RUN_BUY',
        actualPrice: null,           // 由 signal 提供
        tokenAmount: amountSol * (1 - this.simulatedSlippage - this.simulatedFee),
        feeSol: amountSol * this.simulatedFee,
      };
    }
    // 实盘:Jupiter v6 quote + swap
    // 1. GET https://quote-api.jup.ag/v6/quote?inputMint=So11..&outputMint=...&amount=...&slippageBps=1500
    // 2. POST /v6/swap with { quoteResponse, userPublicKey, prioritizationFeeLamports: 'auto' }
    // 3. sign + send
    // 这里留接口,你按 V5 已有的 Jupiter 调用填
    throw new Error('实盘 swap 未实现,请填入你的 Jupiter 调用代码');
  }

  async swapTokenToSol({ tokenAddress, tokenAmount, slippageBps }) {
    if (this.dryRun) {
      return {
        ok: true,
        txSig: 'DRY_RUN_SELL',
        actualPrice: null,
        solAmount: tokenAmount * (1 - this.simulatedSlippage - this.simulatedFee),
      };
    }
    throw new Error('实盘 swap 未实现');
  }
}

module.exports = Executor;
