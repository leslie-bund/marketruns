import { describe, expect, it } from "vitest";
import { PaymentRecoveryResponseSchema } from "../src/index.js";

const response = {
  items: [
    {
      settlementRecordId: "run:cart:Balogun:buyer:1:settlement",
      runId: "run:cart:Balogun:buyer:1",
      market: "Balogun",
      buyerId: "buyer:1",
      runnerId: "runner:internal",
      issues: [
        {
          kind: "dispatch",
          id: "run:cart:Balogun:buyer:1:dispatch:0",
          status: "failed",
          amountKobo: 148_500,
          updatedAt: 1_800_000_000_000,
        },
      ],
      actions: [
        { type: "replay-dispatch", targetId: "run:cart:Balogun:buyer:1:dispatch:0" },
        { type: "redrive-settlement", targetId: "run:cart:Balogun:buyer:1:settlement" },
      ],
    },
  ],
  total: 1,
};

describe("PaymentRecoveryResponseSchema", () => {
  it("round-trips grouped recovery items with numeric timestamps and nullable amounts", () => {
    const parsed = PaymentRecoveryResponseSchema.parse(JSON.parse(JSON.stringify(response)));

    expect(parsed).toEqual(response);
    expect(PaymentRecoveryResponseSchema.parse({
      items: [{
        ...response.items[0],
        issues: [{ ...response.items[0]!.issues[0], kind: "missing", status: "missing", amountKobo: null }],
      }],
      total: 1,
    }).items[0]?.issues[0]?.amountKobo).toBeNull();
  });

  it("is strict at every response level and rejects string timestamps", () => {
    expect(PaymentRecoveryResponseSchema.safeParse({ ...response, extra: true }).success).toBe(false);
    expect(PaymentRecoveryResponseSchema.safeParse({
      ...response,
      items: [{ ...response.items[0], extra: true }],
    }).success).toBe(false);
    expect(PaymentRecoveryResponseSchema.safeParse({
      ...response,
      items: [{ ...response.items[0], issues: [{ ...response.items[0]!.issues[0], extra: true }] }],
    }).success).toBe(false);
    expect(PaymentRecoveryResponseSchema.safeParse({
      ...response,
      items: [{ ...response.items[0], actions: [{ ...response.items[0]!.actions[0], extra: true }] }],
    }).success).toBe(false);
    expect(PaymentRecoveryResponseSchema.safeParse({
      ...response,
      items: [{
        ...response.items[0],
        issues: [{ ...response.items[0]!.issues[0], updatedAt: "2027-01-15T00:00:00.000Z" }],
      }],
    }).success).toBe(false);
  });
});
