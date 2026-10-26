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
  const captured = input.sellers.reduce((sum, seller) => sum + BigInt(seller.amountKobo), 0n) + BigInt(input.deliveryPriceKobo);
  const released = outcome.sellers.reduce((sum, seller) => sum + BigInt(seller.amountKobo), 0n) +
    BigInt(outcome.runnerKobo) + BigInt(outcome.platformKobo) + BigInt(outcome.buyerRefundKobo);
  expect(released).toBe(captured);
  expect(released).toBeLessThanOrEqual(captured);
  expect(outcome.runnerKobo).toBeGreaterThanOrEqual(0);
  expect(outcome.platformKobo).toBeGreaterThanOrEqual(0);
  expect(outcome.buyerRefundKobo).toBeGreaterThanOrEqual(0);
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

  it("supports a MAX_SAFE seller at 100% commission and rejects an unsafe commission total", () => {
    const seller = { sellerId: "seller-a", amountKobo: Number.MAX_SAFE_INTEGER, stopCompleted: true };
    const input: SettlementInput = {
      mode: "completed",
      sellers: [seller],
      deliveryPriceKobo: 0,
      deliveryMarginKobo: 0,
      goodsCommissionBps: 10_000,
    };
    const outcome = settle(input);
    expect(outcome.sellers).toEqual([{ sellerId: "seller-a", amountKobo: 0 }]);
    expect(outcome.platformKobo).toBe(Number.MAX_SAFE_INTEGER);
    expectConserved(input, outcome);
    expect(() => settle({ ...input, sellers: [seller, { ...seller, sellerId: "seller-b" }] }))
      .toThrow(/platformKobo.*safe integer/);
  });

  it("uses exact confirmed-fraction arithmetic for five disputed legs with four completed", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const input: SettlementInput = {
      mode: "disputed",
      sellers: [max, 1, 2, 3, 4].map((amountKobo, index) => ({
        sellerId: `seller-${index}`,
        amountKobo,
        stopCompleted: index < 4,
      })),
      deliveryPriceKobo: max,
      deliveryMarginKobo: 0,
      goodsCommissionBps: 0,
      dispute: { ambiguous: false },
    };
    const outcome = settle(input);
    const grossRunner = (BigInt(max) * 4n) / 5n;
    expect(outcome.runnerKobo).toBe(Number(grossRunner));
    expect(outcome.buyerRefundKobo).toBe(Number(4n + BigInt(max) - grossRunner));
    expect(outcome.sellers.map((seller) => seller.amountKobo)).toEqual([max, 1, 2, 3, 0]);
    expectConserved(input, outcome);
  });

  it("uses exact abort policy percentages for a MAX_SAFE delivery price", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const input: SettlementInput = {
      mode: "aborted",
      sellers: [{ sellerId: "seller-a", amountKobo: 0, stopCompleted: false }],
      deliveryPriceKobo: max,
      deliveryMarginKobo: 300,
      goodsCommissionBps: 0,
    };
    const outcome = settle(input);
    const disruption = (BigInt(max) * 2_500n) / 10_000n;
    const platformFee = (BigInt(max) * 1_000n) / 10_000n;
    expect(outcome.runnerKobo).toBe(Number(disruption - 300n));
    expect(outcome.platformKobo).toBe(Number(platformFee + 300n));
    expect(outcome.buyerRefundKobo).toBe(Number(BigInt(max) - disruption - platformFee));
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

  it("funds disputed loss from available platform revenue without exceeding capture", () => {
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
      platformKobo: 0, // revenue 800 less platform loss 800
      buyerRefundKobo: 6_800, // residual 6,000 + platform-funded loss 800
      platformLossKobo: 800,
    });
    expectConserved(input, outcome);
  });

  it("allows no disputed loss or extra refund when a zero-kobo seller leaves no residual", () => {
    const input: SettlementInput = {
      mode: "disputed",
      sellers: [{ sellerId: "seller-zero", amountKobo: 0, stopCompleted: true }],
      deliveryPriceKobo: 100,
      deliveryMarginKobo: 300,
      goodsCommissionBps: 500,
      dispute: { ambiguous: true, requestedPlatformLossKobo: 5_000 },
    };
    const outcome = settle(input);
    expect(outcome).toEqual({
      sellers: [{ sellerId: "seller-zero", amountKobo: 0 }],
      runnerKobo: 0,
      platformKobo: 100,
      buyerRefundKobo: 0,
      platformLossKobo: 0,
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

  it.each([
    [{ disruptionCompensationBps: -1, platformFeeBps: 0, ambiguousLossCapKobo: 0 }, /disruptionCompensationBps/],
    [{ disruptionCompensationBps: 1.5, platformFeeBps: 0, ambiguousLossCapKobo: 0 }, /disruptionCompensationBps/],
    [{ disruptionCompensationBps: 0, platformFeeBps: -1, ambiguousLossCapKobo: 0 }, /platformFeeBps/],
    [{ disruptionCompensationBps: 0, platformFeeBps: 1.5, ambiguousLossCapKobo: 0 }, /platformFeeBps/],
    [{ disruptionCompensationBps: 6_000, platformFeeBps: 5_000, ambiguousLossCapKobo: 0 }, /<= 10000/],
    [{ disruptionCompensationBps: 10_001, platformFeeBps: 0, ambiguousLossCapKobo: 0 }, /<= 10000/],
    [{ disruptionCompensationBps: 0, platformFeeBps: 0, ambiguousLossCapKobo: -1 }, /ambiguousLossCapKobo/],
    [{ disruptionCompensationBps: 0, platformFeeBps: 0, ambiguousLossCapKobo: 1.5 }, /ambiguousLossCapKobo/],
    [{ disruptionCompensationBps: 0, platformFeeBps: 0, ambiguousLossCapKobo: Number.MAX_SAFE_INTEGER + 1 }, /ambiguousLossCapKobo/],
  ])("rejects invalid abortSplit %#", (abortSplit, error) => {
    expect(() => settle({ ...base, mode: "completed", abortSplit })).toThrow(error);
  });

  it.each([[0, 0], [1, 9_999], [5_000, 5_000], [10_000, 0]])(
    "keeps accepted abort policy %i/%i nonnegative and conserved",
    (disruptionCompensationBps, platformFeeBps) => {
      for (const deliveryPriceKobo of [0, 1, 3, 100]) {
        const input: SettlementInput = {
          ...base,
          mode: "aborted",
          sellers: partialSellers,
          deliveryPriceKobo,
          abortSplit: { disruptionCompensationBps, platformFeeBps, ambiguousLossCapKobo: 0 },
        };
        expectConserved(input, settle(input));
      }
    },
  );

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
