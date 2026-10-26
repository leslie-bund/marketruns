import type { SettlementOutcome } from "@market-runs/domain";
import type { LedgerAccount } from "../../../infra/drizzle/schema.js";

export interface LedgerLeg {
  account: LedgerAccount;
  partyId?: string;
  debitKobo: number;
  creditKobo: number;
  memo: string;
}

/** Convert a settlement result into balanced ledger entries, in integer kobo. */
export function settlementLegs(
  outcome: SettlementOutcome,
  capture: { buyerId: string; runnerId: string },
): LedgerLeg[] {
  const legs: LedgerLeg[] = [];
  const add = (account: LedgerAccount, amount: number, memo: string, partyId?: string, side: "debit" | "credit" = "credit") => {
    if (amount <= 0) return;
    legs.push({ account, ...(partyId ? { partyId } : {}), debitKobo: side === "debit" ? amount : 0, creditKobo: side === "credit" ? amount : 0, memo });
  };
  for (const seller of outcome.sellers) add("seller_payable", seller.amountKobo, "Seller settlement", seller.sellerId);
  add("runner_payable", outcome.runnerKobo, "Runner settlement", capture.runnerId);
  add("platform_revenue", outcome.platformKobo, "Platform settlement");
  add("buyer_refund", outcome.buyerRefundKobo, "Buyer settlement refund", capture.buyerId);
  const captureKobo = legs.reduce((sum, leg) => sum + leg.creditKobo, 0);
  // Dispute loss is already deducted from platform revenue in the outcome; it
  // is disclosure, not an external funding leg. All credited value comes from
  // the buyer capture, so total outflows cannot exceed that capture.
  if (captureKobo > 0) add("buyer_capture", captureKobo, "Buyer capture", capture.buyerId, "debit");
  return legs;
}
