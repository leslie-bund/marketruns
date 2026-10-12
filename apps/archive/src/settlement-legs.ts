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
  capture: { buyerId: string },
): LedgerLeg[] {
  const legs: LedgerLeg[] = [];
  const add = (account: LedgerAccount, amount: number, memo: string, partyId?: string, side: "debit" | "credit" = "credit") => {
    if (amount <= 0) return;
    legs.push({ account, ...(partyId ? { partyId } : {}), debitKobo: side === "debit" ? amount : 0, creditKobo: side === "credit" ? amount : 0, memo });
  };
  for (const seller of outcome.sellers) add("seller_payable", seller.amountKobo, "Seller settlement", seller.sellerId);
  add("runner_payable", outcome.runnerKobo, "Runner settlement", "internal-runner");
  add("platform_revenue", outcome.platformKobo, "Platform settlement");
  add("buyer_refund", outcome.buyerRefundKobo, "Buyer settlement refund", capture.buyerId);
  add("platform_loss", outcome.platformLossKobo, "Capped ambiguous dispute loss", undefined, "debit");
  const credited = legs.reduce((sum, leg) => sum + leg.creditKobo, 0);
  const debited = legs.reduce((sum, leg) => sum + leg.debitKobo, 0);
  // The capture is the balancing source for all released value, excluding the
  // separately recorded platform loss (which is a debit).
  const captureKobo = credited - debited;
  if (captureKobo > 0) add("buyer_capture", captureKobo, "Buyer capture", capture.buyerId, "debit");
  return legs;
}
