export type SettlementMode = "completed" | "aborted" | "disputed";

export interface SellerAmount {
  sellerId: string;
  amountKobo: number;
  stopCompleted: boolean;
}

export interface AbortSplit {
  /** Fraction of delivery price paid to the Runner for disruption, in basis points. */
  disruptionCompensationBps: number;
  /** Fraction of delivery price retained by the platform, in basis points. */
  platformFeeBps: number;
  /** Maximum loss absorbed by the platform in an ambiguous dispute, in kobo. */
  ambiguousLossCapKobo: number;
}

export const MVP_ABORT_SPLIT: AbortSplit = {
  disruptionCompensationBps: 2_500,
  platformFeeBps: 1_000,
  ambiguousLossCapKobo: 5_000,
};

export interface SettlementInput {
  mode: SettlementMode;
  sellers: SellerAmount[];
  /** Gross delivery proceeds captured from the buyer, before the runner deduction. */
  deliveryPriceKobo: number;
  /** Maximum platform deduction from the runner's gross delivery payout. */
  deliveryMarginKobo: number;
  /** Commission deducted independently from each completed seller's goods proceeds. */
  goodsCommissionBps: number;
  abortSplit?: AbortSplit;
  /** In disputed mode, evidence resolves to these adjustments within this function. */
  dispute?: {
    ambiguous: boolean;
    /** Amount of buyer loss the platform absorbs when evidence is ambiguous. */
    requestedPlatformLossKobo?: number;
  };
}

export interface SettlementOutcome {
  sellers: Array<{ sellerId: string; amountKobo: number }>;
  runnerKobo: number;
  platformKobo: number;
  buyerRefundKobo: number;
  platformLossKobo: number;
}

const bps = 10_000;
const floor = Math.floor;

function requireKobo(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be non-negative integer kobo`);
}

/** Exact floor(amount * commission / 10000) without overflowing the intermediate product. */
function sellerCommission(amountKobo: number, commissionBps: number): number {
  return Number((BigInt(amountKobo) * BigInt(commissionBps)) / BigInt(bps));
}

function paySellers(sellers: SellerAmount[], commissionBps: number, completedOnly = false) {
  let commissionKobo = 0;
  const payouts = sellers.map(({ sellerId, amountKobo, stopCompleted }) => {
    if (completedOnly && !stopCompleted) return { sellerId, amountKobo: 0 };
    const commission = sellerCommission(amountKobo, commissionBps);
    commissionKobo += commission;
    return { sellerId, amountKobo: amountKobo - commission };
  });
  return { payouts, commissionKobo };
}

function runnerPayout(grossKobo: number, configuredMarginKobo: number) {
  const marginKobo = Math.min(configuredMarginKobo, grossKobo);
  return { netKobo: grossKobo - marginKobo, marginKobo };
}

export function settle(input: SettlementInput): SettlementOutcome {
  requireKobo(input.deliveryPriceKobo, "deliveryPriceKobo");
  requireKobo(input.deliveryMarginKobo, "deliveryMarginKobo");
  const policy = input.abortSplit ?? MVP_ABORT_SPLIT;
  const goodsTotal = input.sellers.reduce((sum, seller) => {
    requireKobo(seller.amountKobo, "seller amount");
    return sum + seller.amountKobo;
  }, 0);
  if (!Number.isSafeInteger(input.goodsCommissionBps) || input.goodsCommissionBps < 0 || input.goodsCommissionBps > bps) {
    throw new RangeError("goodsCommissionBps must be between 0 and 10000");
  }
  const capturedTotal = goodsTotal + input.deliveryPriceKobo;

  if (input.mode === "completed") {
    const sellerSettlement = paySellers(input.sellers, input.goodsCommissionBps);
    const runner = runnerPayout(input.deliveryPriceKobo, input.deliveryMarginKobo);
    return {
      sellers: sellerSettlement.payouts,
      runnerKobo: runner.netKobo,
      platformKobo: sellerSettlement.commissionKobo + runner.marginKobo,
      buyerRefundKobo: 0,
      platformLossKobo: 0,
    };
  }

  if (input.mode === "aborted") {
    const completedGoods = input.sellers.filter((seller) => seller.stopCompleted);
    const failedGoods = input.sellers.filter((seller) => !seller.stopCompleted);
    const completedTotal = completedGoods.reduce((sum, seller) => sum + seller.amountKobo, 0);
    const disruption = floor((input.deliveryPriceKobo * policy.disruptionCompensationBps) / bps);
    const platformFee = floor((input.deliveryPriceKobo * policy.platformFeeBps) / bps);
    const sellerSettlement = paySellers(completedGoods, input.goodsCommissionBps);
    sellerSettlement.payouts.push(...failedGoods.map(({ sellerId }) => ({ sellerId, amountKobo: 0 })));
    const runner = runnerPayout(disruption, input.deliveryMarginKobo);
    // The buyer receives the residual capture. Participant deductions fund
    // platform revenue; they are not additional components of the buyer bill.
    const buyerRefund = goodsTotal - completedTotal + input.deliveryPriceKobo - disruption - platformFee;
    if (buyerRefund >= capturedTotal) {
      throw new Error("aborted settlement must retain friction — a full-capture refund violates ADR-0008");
    }
    return {
      sellers: sellerSettlement.payouts,
      runnerKobo: runner.netKobo,
      platformKobo: sellerSettlement.commissionKobo + platformFee + runner.marginKobo,
      buyerRefundKobo: buyerRefund,
      platformLossKobo: 0,
    };
  }

  // Disputed mode: the evidence layer marks which Exchange Points confirmed.
  // Confirmed stops still settle less their commission; the Buyer recovers the
  // disputed residual. Delivery margin comes only out of the gross runner
  // payout, so no confirmed stops means no runner-funded platform margin.
  // The platform absorbs an additional, capped loss only when ambiguous
  // (ADR-0007).
  const disputed = input.dispute ?? { ambiguous: true };
  const completedGoods = input.sellers.filter((seller) => seller.stopCompleted);
  const completedTotal = completedGoods.reduce((sum, seller) => sum + seller.amountKobo, 0);
  const confirmedFraction = input.sellers.length === 0 ? 0 : completedGoods.length / input.sellers.length;
  const grossRunnerPayout = floor(input.deliveryPriceKobo * confirmedFraction);
  const sellerSettlement = paySellers(input.sellers, input.goodsCommissionBps, true);
  const runner = runnerPayout(grossRunnerPayout, input.deliveryMarginKobo);
  const buyersPool = goodsTotal - completedTotal + input.deliveryPriceKobo - grossRunnerPayout;
  let platformLoss = 0;
  if (disputed.ambiguous) {
    requireKobo(disputed.requestedPlatformLossKobo ?? 0, "requestedPlatformLossKobo");
    platformLoss = Math.min(disputed.requestedPlatformLossKobo ?? 0, policy.ambiguousLossCapKobo);
  }
  return {
    sellers: sellerSettlement.payouts,
    runnerKobo: runner.netKobo,
    platformKobo: sellerSettlement.commissionKobo + runner.marginKobo,
    buyerRefundKobo: buyersPool + platformLoss,
    platformLossKobo: platformLoss,
  };
}
