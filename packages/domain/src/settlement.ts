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
  deliveryPriceKobo: number;
  deliveryMarginKobo: number;
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

  if (input.mode === "completed") {
    const commission = floor((goodsTotal * input.goodsCommissionBps) / bps);
    return {
      sellers: input.sellers.map(({ sellerId, amountKobo }) => ({ sellerId, amountKobo })),
      runnerKobo: input.deliveryPriceKobo,
      platformKobo: commission + input.deliveryMarginKobo,
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
    const sellerPayouts = completedGoods.map(({ sellerId, amountKobo }) => ({ sellerId, amountKobo }));
    sellerPayouts.push(...failedGoods.map(({ sellerId }) => ({ sellerId, amountKobo: 0 })));
    const buyerRefund = goodsTotal - completedTotal + input.deliveryPriceKobo - disruption - platformFee + input.deliveryMarginKobo;
    const capturedTotal = goodsTotal + input.deliveryPriceKobo + input.deliveryMarginKobo;
    if (buyerRefund >= capturedTotal) {
      throw new Error("aborted settlement must retain friction — a full-capture refund violates ADR-0008");
    }
    return {
      sellers: sellerPayouts,
      runnerKobo: disruption,
      platformKobo: platformFee,
      buyerRefundKobo: buyerRefund,
      platformLossKobo: 0,
    };
  }

  // Disputed mode: the evidence layer marks which Exchange Points confirmed.
  // Confirmed stops still settle; the Buyer recovers the disputed residual.
  // A full refund of goods and delivery exists only when no Exchange Point was
  // confirmed — a failure before the Runner took custody. The platform retains
  // its delivery margin on disputed closes (founder decision, 2026-10-11) and
  // absorbs an additional, capped loss only when the evidence is ambiguous
  // (ADR-0007).
  const disputed = input.dispute ?? { ambiguous: true };
  const completedGoods = input.sellers.filter((seller) => seller.stopCompleted);
  const completedTotal = completedGoods.reduce((sum, seller) => sum + seller.amountKobo, 0);
  const confirmedFraction = input.sellers.length === 0 ? 0 : completedGoods.length / input.sellers.length;
  const runnerPayout = floor(input.deliveryPriceKobo * confirmedFraction);
  const buyersPool = goodsTotal - completedTotal + input.deliveryPriceKobo - runnerPayout;
  let platformLoss = 0;
  if (disputed.ambiguous) {
    requireKobo(disputed.requestedPlatformLossKobo ?? 0, "requestedPlatformLossKobo");
    platformLoss = Math.min(disputed.requestedPlatformLossKobo ?? 0, policy.ambiguousLossCapKobo);
  }
  return {
    sellers: input.sellers.map(({ sellerId, amountKobo, stopCompleted }) => ({
      sellerId,
      amountKobo: stopCompleted ? amountKobo : 0,
    })),
    runnerKobo: runnerPayout,
    platformKobo: input.deliveryMarginKobo,
    buyerRefundKobo: buyersPool + platformLoss,
    platformLossKobo: platformLoss,
  };
}
