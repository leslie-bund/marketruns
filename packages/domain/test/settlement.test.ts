import { describe, expect, it } from "vitest";
import { settle, type SettlementInput, type SettlementOutcome } from "../src/index.js";

const base = {
  sellers: [
    { sellerId: "seller-a", amountKobo: 10_000, stopCompleted: true },
    { sellerId: "seller-b", amountKobo: 5_000, stopCompleted: true },
  ],
  deliveryPriceKobo: 2_000,
  deliveryMarginKobo: 300,
  goodsCommissionBps: 500,
};

const partialSellers = [base.sellers[0]!, { ...base.sellers[1]!, stopCompleted: false }];

function expectConserved(input: SettlementInput, outcome: SettlementOutcome): void {
  const captured = input.sellers.reduce((sum, seller) => sum + seller.amountKobo, 0) + input.deliveryPriceKobo;
  const released = outcome.sellers.reduce((sum, seller) => sum + seller.amountKobo, 0) +
    outcome.runnerKobo + outcome.platformKobo + outcome.buyerRefundKobo - outcome.platformLossKobo;
  expect(released).toBe(captured);
  expect(outcome.runnerKobo).toBeGreaterThanOrEqual(0);
  expect(outcome.sellers.every((seller) => seller.amountKobo >= 0)).toBe(true);
}

describe("Settlement", () => {
  it("deducts per-seller commissions and runner margin from a completed capture", () => {
    const input: SettlementInput = { ...base, mode: "completed" };
    const outcome = settle(input);
    expect(outcome).toEqual({
      sellers: [{ sellerId: "seller-a", amountKobo: 9_500 }, { sellerId: "seller-b", amountKobo: 4_750 }],
      runnerKobo: 1_700,
      platformKobo: 1_050,
      buyerRefundKobo: 0,
      platformLossKobo: 0,
    });
    expectConserved(input, outcome);
  });

  it("rounds each seller's commission independently and sums actual withholding", () => {
    const input: SettlementInput = {
      mode: "completed",
      sellers: [
        { sellerId: "seller-a", amountKobo: 101, stopCompleted: true },
        { sellerId: "seller-b", amountKobo: 202, stopCompleted: true },
        { sellerId: "seller-c", amountKobo: 303, stopCompleted: true },
      ],
      deliveryPriceKobo: 1_000,
      deliveryMarginKobo: 0,
      goodsCommissionBps: 333,
    };
    const outcome = settle(input);
    expect(outcome.sellers).toEqual([
      { sellerId: "seller-a", amountKobo: 98 },
      { sellerId: "seller-b", amountKobo: 196 },
      { sellerId: "seller-c", amountKobo: 293 },
    ]);
    expect(outcome.platformKobo).toBe(19); // 3 + 6 + 10, not floor(606 * 333 / 10000) = 20
    expectConserved(input, outcome);
  });

  it("keeps commission exact when the kobo multiplication would exceed Number precision", () => {
    const input: SettlementInput = {
      mode: "completed",
      sellers: [{ sellerId: "seller-a", amountKobo: Number.MAX_SAFE_INTEGER, stopCompleted: true }],
      deliveryPriceKobo: 0,
      deliveryMarginKobo: 0,
      goodsCommissionBps: 333,
    };
    const outcome = settle(input);
    const commission = Number((BigInt(Number.MAX_SAFE_INTEGER) * 333n) / 10_000n);
    expect(outcome.platformKobo).toBe(commission);
    expect(outcome.sellers).toEqual([{ sellerId: "seller-a", amountKobo: Number.MAX_SAFE_INTEGER - commission }]);
    expectConserved(input, outcome);
  });

  it("keeps the exact abort split and conserves the 17,000 kobo capture", () => {
    const input: SettlementInput = { ...base, mode: "aborted", sellers: partialSellers };
    const outcome = settle(input);
    expect(outcome).toEqual({
      sellers: [{ sellerId: "seller-a", amountKobo: 9_500 }, { sellerId: "seller-b", amountKobo: 0 }],
      runnerKobo: 200, // gross disruption 500 less margin 300
      platformKobo: 1_000, // seller commission 500 + policy fee 200 + runner margin 300
      buyerRefundKobo: 6_300,
      platformLossKobo: 0,
    });
    expect(outcome.buyerRefundKobo).toBeLessThan(17_000);
    expectConserved(input, outcome);
  });

  it("keeps the exact disputed split, including capped platform-funded loss", () => {
    const input: SettlementInput = {
      ...base,
      mode: "disputed",
      sellers: partialSellers,
      dispute: { ambiguous: true, requestedPlatformLossKobo: 99_000 },
    };
    const outcome = settle(input);
    expect(outcome).toEqual({
      sellers: [{ sellerId: "seller-a", amountKobo: 9_500 }, { sellerId: "seller-b", amountKobo: 0 }],
      runnerKobo: 700, // gross confirmed fraction 1,000 less margin 300
      platformKobo: 800, // seller commission 500 + runner margin 300
      buyerRefundKobo: 11_000,
      platformLossKobo: 5_000,
    });
    expectConserved(input, outcome);
  });

  it("settles a fully confirmed resolved dispute like a completed run", () => {
    const input: SettlementInput = { ...base, mode: "disputed", dispute: { ambiguous: false } };
    expect(settle(input)).toEqual(settle({ ...base, mode: "completed" }));
    expectConserved(input, settle(input));
  });

  it.each(["completed", "aborted", "disputed"] as const)("caps an excessive runner margin in %s mode", (mode) => {
    const input: SettlementInput = {
      ...base,
      mode,
      deliveryMarginKobo: 3_000,
      sellers: mode === "completed" ? base.sellers : partialSellers,
      ...(mode === "disputed" ? { dispute: { ambiguous: false } } : {}),
    };
    const outcome = settle(input);
    const grossRunner = mode === "completed" ? 2_000 : mode === "aborted" ? 500 : 1_000;
    expect(outcome.runnerKobo).toBe(0);
    expect(outcome.platformKobo).toBe((mode === "completed" ? 750 : 500) + grossRunner + (mode === "aborted" ? 200 : 0));
    expectConserved(input, outcome);
  });

  it.each(["completed", "aborted", "disputed"] as const)("supports zero commission and margin in %s mode", (mode) => {
    const input: SettlementInput = {
      ...base,
      mode,
      deliveryMarginKobo: 0,
      goodsCommissionBps: 0,
      sellers: mode === "completed" ? base.sellers : partialSellers,
      ...(mode === "disputed" ? { dispute: { ambiguous: false } } : {}),
    };
    const outcome = settle(input);
    expect(outcome.platformKobo).toBe(mode === "aborted" ? 200 : 0);
    expect(outcome.runnerKobo).toBe(mode === "completed" ? 2_000 : mode === "aborted" ? 500 : 1_000);
    expectConserved(input, outcome);
  });

  it("refuses an abort that would refund the full capture — zero delivery price leaves no friction (ADR-0008)", () => {
    expect(() =>
      settle({
        ...base,
        mode: "aborted",
        deliveryPriceKobo: 0,
        sellers: base.sellers.map((seller) => ({ ...seller, stopCompleted: false })),
      }),
    ).toThrow(/ADR-0008/);
  });

  it("refuses an abort whose friction rounds to zero on a negligible delivery price (ADR-0008)", () => {
    expect(() =>
      settle({
        ...base,
        mode: "aborted",
        deliveryPriceKobo: 3,
        sellers: base.sellers.map((seller) => ({ ...seller, stopCompleted: false })),
      }),
    ).toThrow(/ADR-0008/);
  });

  it("creates no margin without a gross runner payout when no Exchange Point was confirmed", () => {
    const input: SettlementInput = {
      ...base,
      mode: "disputed",
      sellers: base.sellers.map((seller) => ({ ...seller, stopCompleted: false })),
      dispute: { ambiguous: true, requestedPlatformLossKobo: 0 },
    };
    const outcome = settle(input);
    expect(outcome).toEqual({
      sellers: [{ sellerId: "seller-a", amountKobo: 0 }, { sellerId: "seller-b", amountKobo: 0 }],
      runnerKobo: 0,
      platformKobo: 0,
      buyerRefundKobo: 17_000,
      platformLossKobo: 0,
    });
    expectConserved(input, outcome);
  });
});
