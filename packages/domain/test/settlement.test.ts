import { describe, expect, it } from "vitest";
import { settle } from "../src/index.js";

const base = {
  sellers: [
    { sellerId: "seller-a", amountKobo: 10_000, stopCompleted: true },
    { sellerId: "seller-b", amountKobo: 5_000, stopCompleted: true },
  ],
  deliveryPriceKobo: 2_000,
  deliveryMarginKobo: 300,
  goodsCommissionBps: 500,
};

describe("Settlement", () => {
  it("splits completed goods, delivery, and platform revenue", () => {
    expect(settle({ ...base, mode: "completed" })).toEqual({
      sellers: [{ sellerId: "seller-a", amountKobo: 10_000 }, { sellerId: "seller-b", amountKobo: 5_000 }],
      runnerKobo: 2_000,
      platformKobo: 1_050,
      buyerRefundKobo: 0,
      platformLossKobo: 0,
    });
  });

  it("partially settles an abort and never refunds the full capture", () => {
    const outcome = settle({
      ...base,
      mode: "aborted",
      sellers: [base.sellers[0]!, { ...base.sellers[1]!, stopCompleted: false }],
    });
    expect(outcome.sellers).toEqual([{ sellerId: "seller-a", amountKobo: 10_000 }, { sellerId: "seller-b", amountKobo: 0 }]);
    expect(outcome.runnerKobo).toBeGreaterThan(0);
    expect(outcome.platformKobo).toBeGreaterThan(0);
    expect(outcome.buyerRefundKobo).toBeLessThan(17_300);
  });

  it("caps the platform loss for an ambiguous dispute", () => {
    const outcome = settle({
      ...base,
      mode: "disputed",
      dispute: { ambiguous: true, requestedPlatformLossKobo: 99_000 },
    });
    expect(outcome.platformLossKobo).toBe(5_000);
    expect(outcome.buyerRefundKobo).toBe(17_300);
  });
});
