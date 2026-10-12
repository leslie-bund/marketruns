import { describe, expect, it } from "vitest";
import { settle, MVP_ABORT_SPLIT, type SettlementInput } from "@market-runs/domain";
import { settlementLegs } from "../src/settlement-legs.js";

const completed: SettlementInput = {
  mode: "completed", sellers: [{ sellerId: "seller-1", amountKobo: 10_000, stopCompleted: true }],
  deliveryPriceKobo: 2_000, deliveryMarginKobo: 100, goodsCommissionBps: 1_000,
};
const aborted: SettlementInput = {
  mode: "aborted", sellers: [{ sellerId: "seller-1", amountKobo: 10_000, stopCompleted: false }],
  deliveryPriceKobo: 2_000, deliveryMarginKobo: 100, goodsCommissionBps: 1_000, abortSplit: MVP_ABORT_SPLIT,
};
const disputed: SettlementInput = {
  ...aborted, mode: "disputed", dispute: { ambiguous: true, requestedPlatformLossKobo: 9_000 },
};

describe("settlement ledger legs", () => {
  it("maps completed settlement", () => {
    const outcome = settle(completed);
    const legs = settlementLegs(outcome, { buyerId: "buyer-1" });
    expect(legs.find((leg) => leg.account === "seller_payable")?.creditKobo).toBe(10_000);
    expect(legs.find((leg) => leg.account === "runner_payable")?.creditKobo).toBe(2_000);
    expect(legs.find((leg) => leg.account === "platform_revenue")?.creditKobo).toBe(1_100);
    expect(isBalanced(legs)).toBe(true);
  });

  it("maps abort friction with platform fee, runner disruption, and buyer remainder", () => {
    const outcome = settle(aborted);
    const legs = settlementLegs(outcome, { buyerId: "buyer-1" });
    // Exact split per MVP_ABORT_SPLIT (delivery-based): disruption 25%,
    // platform fee 10% of the 2,000 delivery price; the buyer receives the
    // remainder of the 12,100 capture — never a full refund (ADR-0008).
    expect(outcome.runnerKobo).toBe(500);
    expect(outcome.platformKobo).toBe(200);
    expect(outcome.buyerRefundKobo).toBe(11_400);
    expect(outcome.buyerRefundKobo).toBeLessThan(12_100); // capture: goods 10,000 + delivery 2,000 + margin 100
    expect(legs.find((leg) => leg.account === "buyer_capture")?.debitKobo).toBe(12_100);
    expect(isBalanced(legs)).toBe(true);
  });

  it("caps ambiguous platform loss", () => {
    const outcome = settle(disputed);
    expect(outcome.platformLossKobo).toBe(MVP_ABORT_SPLIT.ambiguousLossCapKobo);
    expect(settlementLegs(outcome, { buyerId: "buyer-1" }).find((leg) => leg.account === "platform_loss")?.debitKobo)
      .toBe(MVP_ABORT_SPLIT.ambiguousLossCapKobo);
  });

  it("balances every settlement mode", () => {
    for (const input of [completed, aborted, disputed]) {
      expect(isBalanced(settlementLegs(settle(input), { buyerId: "buyer-1" }))).toBe(true);
    }
  });
});

function isBalanced(legs: ReturnType<typeof settlementLegs>): boolean {
  return legs.reduce((sum, leg) => sum + leg.debitKobo, 0) === legs.reduce((sum, leg) => sum + leg.creditKobo, 0);
}
