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
const bpsBigInt = BigInt(bps);
const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);

function requireKobo(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be non-negative integer kobo`);
}

function requireBps(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer`);
}

function validateAbortSplit(policy: AbortSplit): void {
  requireBps(policy.disruptionCompensationBps, "disruptionCompensationBps");
  requireBps(policy.platformFeeBps, "platformFeeBps");
  requireKobo(policy.ambiguousLossCapKobo, "ambiguousLossCapKobo");
  if (policy.disruptionCompensationBps + policy.platformFeeBps > bps) {
    throw new RangeError("disruptionCompensationBps + platformFeeBps must be <= 10000");
  }
}

/** Convert only after exact bigint arithmetic; never emit an unsafe or negative money value. */
function toKobo(value: bigint, label: string): number {
  if (value < 0n || value > maxSafeInteger) throw new RangeError(`${label} must be non-negative safe integer kobo`);
  return Number(value);
}

interface ExactSellerAmount {
  sellerId: string;
  amountKobo: bigint;
  stopCompleted: boolean;
}

function paySellers(sellers: ExactSellerAmount[], commissionBps: bigint, completedOnly = false) {
  let commissionKobo = 0n;
  const payouts = sellers.map(({ sellerId, amountKobo, stopCompleted }) => {
    if (completedOnly && !stopCompleted) return { sellerId, amountKobo: 0n };
    const commission = (amountKobo * commissionBps) / bpsBigInt;
    commissionKobo += commission;
    return { sellerId, amountKobo: amountKobo - commission };
  });
  return { payouts, commissionKobo };
}

function runnerPayout(grossKobo: bigint, configuredMarginKobo: bigint) {
  const marginKobo = configuredMarginKobo < grossKobo ? configuredMarginKobo : grossKobo;
  return { netKobo: grossKobo - marginKobo, marginKobo };
}

function outputSellers(sellers: Array<{ sellerId: string; amountKobo: bigint }>) {
  return sellers.map((seller) => ({ sellerId: seller.sellerId, amountKobo: toKobo(seller.amountKobo, "seller payout") }));
}

export function settle(input: SettlementInput): SettlementOutcome {
  requireKobo(input.deliveryPriceKobo, "deliveryPriceKobo");
  requireKobo(input.deliveryMarginKobo, "deliveryMarginKobo");
  const policy = input.abortSplit ?? MVP_ABORT_SPLIT;
  validateAbortSplit(policy);
  if (!Number.isSafeInteger(input.goodsCommissionBps) || input.goodsCommissionBps < 0 || input.goodsCommissionBps > bps) {
    throw new RangeError("goodsCommissionBps must be between 0 and 10000");
  }
  const sellers: ExactSellerAmount[] = input.sellers.map((seller) => {
    requireKobo(seller.amountKobo, "seller amount");
    return { ...seller, amountKobo: BigInt(seller.amountKobo) };
  });
  const goodsTotal = sellers.reduce((sum, seller) => sum + seller.amountKobo, 0n);
  const deliveryPrice = BigInt(input.deliveryPriceKobo);
  const deliveryMargin = BigInt(input.deliveryMarginKobo);
  const commissionBps = BigInt(input.goodsCommissionBps);
  const capturedTotal = goodsTotal + deliveryPrice;

  if (input.mode === "completed") {
    const sellerSettlement = paySellers(sellers, commissionBps);
    const runner = runnerPayout(deliveryPrice, deliveryMargin);
    return {
      sellers: outputSellers(sellerSettlement.payouts),
      runnerKobo: toKobo(runner.netKobo, "runnerKobo"),
      platformKobo: toKobo(sellerSettlement.commissionKobo + runner.marginKobo, "platformKobo"),
      buyerRefundKobo: 0,
      platformLossKobo: 0,
    };
  }

  if (input.mode === "aborted") {
    const completedGoods = sellers.filter((seller) => seller.stopCompleted);
    const failedGoods = sellers.filter((seller) => !seller.stopCompleted);
    const completedTotal = completedGoods.reduce((sum, seller) => sum + seller.amountKobo, 0n);
    const disruption = (deliveryPrice * BigInt(policy.disruptionCompensationBps)) / bpsBigInt;
    const platformFee = (deliveryPrice * BigInt(policy.platformFeeBps)) / bpsBigInt;
    const sellerSettlement = paySellers(completedGoods, commissionBps);
    sellerSettlement.payouts.push(...failedGoods.map(({ sellerId }) => ({ sellerId, amountKobo: 0n })));
    const runner = runnerPayout(disruption, deliveryMargin);
    // The buyer receives the residual capture. Participant deductions fund
    // platform revenue; they are not additional components of the buyer bill.
    const buyerRefund = goodsTotal - completedTotal + deliveryPrice - disruption - platformFee;
    if (buyerRefund >= capturedTotal) {
      throw new Error("aborted settlement must retain friction — a full-capture refund violates ADR-0008");
    }
    return {
      sellers: outputSellers(sellerSettlement.payouts),
      runnerKobo: toKobo(runner.netKobo, "runnerKobo"),
      platformKobo: toKobo(sellerSettlement.commissionKobo + platformFee + runner.marginKobo, "platformKobo"),
      buyerRefundKobo: toKobo(buyerRefund, "buyerRefundKobo"),
      platformLossKobo: 0,
    };
  }

  // Disputed mode: confirmed stops settle less commission and the Buyer gets
  // the residual. Ambiguous loss moves available platform revenue to the Buyer;
  // it never creates an outflow beyond capture (ADR-0007).
  const disputed = input.dispute ?? { ambiguous: true };
  const completedGoods = sellers.filter((seller) => seller.stopCompleted);
  const completedTotal = completedGoods.reduce((sum, seller) => sum + seller.amountKobo, 0n);
  const grossRunnerPayout = sellers.length === 0
    ? 0n
    : (deliveryPrice * BigInt(completedGoods.length)) / BigInt(sellers.length);
  const sellerSettlement = paySellers(sellers, commissionBps, true);
  const runner = runnerPayout(grossRunnerPayout, deliveryMargin);
  const buyersPool = goodsTotal - completedTotal + deliveryPrice - grossRunnerPayout;
  const platformRevenue = sellerSettlement.commissionKobo + runner.marginKobo;
  let platformLoss = 0n;
  if (disputed.ambiguous) {
    const requested = disputed.requestedPlatformLossKobo ?? 0;
    requireKobo(requested, "requestedPlatformLossKobo");
    const requestedLoss = BigInt(requested);
    const policyCap = BigInt(policy.ambiguousLossCapKobo);
    platformLoss = [requestedLoss, policyCap, buyersPool, platformRevenue].reduce((min, value) => value < min ? value : min);
  }
  return {
    sellers: outputSellers(sellerSettlement.payouts),
    runnerKobo: toKobo(runner.netKobo, "runnerKobo"),
    platformKobo: toKobo(platformRevenue - platformLoss, "platformKobo"),
    buyerRefundKobo: toKobo(buyersPool + platformLoss, "buyerRefundKobo"),
    platformLossKobo: toKobo(platformLoss, "platformLossKobo"),
  };
}
