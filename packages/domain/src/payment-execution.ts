import type { SettlementOutcome } from "./settlement.js";

/**
 * Payment dispatch request construction for a closing Run.
 *
 * Doctrine (ADR-0007/0008): the settlement function ALREADY ran — its
 * outcome IS the money decision. Dispatch is execution only: handing the
 * computed payout legs (seller payouts, runner payout, platform commission)
 * to the payment queue for the PSP abstraction to move. Nothing here
 * recomputes, rounds, or adjusts a single kobo.
 *
 * Vendor-neutral (ADR-0009): the wire speaks in accounts and references,
 * never in PSP shapes; the dispatcher implementation in apps/payments is
 * the only place a vendor would appear.
 *
 * Buyer refunds are NOT dispatched as payout legs: when the outcome carries
 * buyerRefundKobo > 0, buildPaymentRefundRequest below emits a separate
 * payment.refund-requested for the refund rail against the buyer's hold
 * (ADR-0023/0024 follow-up).
 */

/** The archive consumer's settlement record id rule, mirrored so the durable record and its dispatches join by text. */
export function settlementRecordIdForRun(runId: string): string {
  return `${runId}:settlement`;
}

/** Build the payment.dispatch-requested queue message for a released settlement. */
export function buildPaymentDispatchRequest(
  outcome: SettlementOutcome,
  context: { runId: string; market: string; runnerId: string; requestId?: string },
) {
  const settlementRecordId = settlementRecordIdForRun(context.runId);
  const legs: Array<{
    account: "seller" | "runner" | "platform";
    partyId: string;
    amountKobo: number;
    memo: string;
  }> = [];
  // Zero-amount legs carry no money and are not dispatched (a leg that pays
  // nothing is a ledger entry, not a transfer).
  for (const seller of outcome.sellers) {
    if (seller.amountKobo <= 0) continue;
    legs.push({
      account: "seller",
      partyId: seller.sellerId,
      amountKobo: seller.amountKobo,
      memo: "Seller settlement",
    });
  }
  if (outcome.runnerKobo > 0) {
    legs.push({
      account: "runner",
      partyId: context.runnerId,
      amountKobo: outcome.runnerKobo,
      memo: "Runner settlement",
    });
  }
  if (outcome.platformKobo > 0) {
    legs.push({
      account: "platform",
      partyId: "platform",
      amountKobo: outcome.platformKobo,
      memo: "Platform settlement",
    });
  }
  return {
    type: "payment.dispatch-requested" as const,
    settlementRecordId,
    runId: context.runId,
    market: context.market,
    legs,
    // One settlement = one dispatch request. Queue redelivery of this message
    // is a replay of the SAME execution request; the consumer is idempotent
    // on this key (per-leg: `${idempotencyKey}:leg:<index>`).
    idempotencyKey: `settlement:${settlementRecordId}`,
    ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
  };
}

/**
 * Buyer refunds are NOT dispatched as payout legs: they release against the
 * buyer's hold (ADR-0023). When the settlement outcome carries
 * buyerRefundKobo > 0 (aborts never refund fully — ADR-0008 — so this is
 * usually a partial amount), this builds the payment.refund-requested queue
 * message for the payments worker's refund rail. Returns null when the
 * settlement refunds nothing.
 */
export function buildPaymentRefundRequest(
  outcome: SettlementOutcome,
  context: { runId: string; buyerId: string; requestId?: string },
) {
  if (outcome.buyerRefundKobo <= 0) return null;
  const settlementRecordId = settlementRecordIdForRun(context.runId);
  return {
    type: "payment.refund-requested" as const,
    settlementRecordId,
    runId: context.runId,
    buyerId: context.buyerId,
    amountKobo: outcome.buyerRefundKobo,
    // One settlement = one refund request; the consumer is idempotent on the
    // settlementRecordId (a UNIQUE column), so a duplicate release is a safe
    // replay.
    idempotencyKey: `refund:${settlementRecordId}`,
    ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
  };
}
