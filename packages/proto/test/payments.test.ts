import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  PaymentDispatchRequestedSchema,
  PaymentDispatchViewSchema,
  ServerEventSchema,
} from "../src/index.js";

/** Serialize → deserialize → parse, proving the wire format round-trips. */
function roundTrip<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}

const dispatchRequested = {
  type: "payment.dispatch-requested",
  settlementRecordId: "run:cart:Balogun:buyer:1:settlement",
  runId: "run:cart:Balogun:buyer:1",
  market: "Balogun",
  legs: [
    { account: "seller", partyId: "seller:amina", amountKobo: 165_000, memo: "Seller settlement" },
    { account: "runner", partyId: "runner:internal", amountKobo: 170_000, memo: "Runner settlement" },
    { account: "platform", partyId: "platform", amountKobo: 26_500, memo: "Platform settlement" },
  ],
  idempotencyKey: "settlement:run:cart:Balogun:buyer:1:settlement",
};

describe("payment.dispatch-requested schema", () => {
  it("round-trips a three-leg dispatch request", () => {
    const parsed = roundTrip(PaymentDispatchRequestedSchema, dispatchRequested);
    expect(parsed.legs).toHaveLength(3);
    expect(parsed.idempotencyKey).toBe("settlement:run:cart:Balogun:buyer:1:settlement");
  });

  it("carries an optional requestId (correlation, append-only)", () => {
    const parsed = roundTrip(PaymentDispatchRequestedSchema, { ...dispatchRequested, requestId: "trace-pay-1" });
    expect(parsed.requestId).toBe("trace-pay-1");
    expect(PaymentDispatchRequestedSchema.safeParse(dispatchRequested).success).toBe(true);
    expect(PaymentDispatchRequestedSchema.safeParse({ ...dispatchRequested, requestId: "bad id" }).success).toBe(false);
  });

  it("is a ServerEvent (the edge places it on the payment queue)", () => {
    expect(() => roundTrip(ServerEventSchema, dispatchRequested)).not.toThrow();
  });

  it("rejects empty legs, unknown accounts, negative kobo, and empty keys", () => {
    expect(PaymentDispatchRequestedSchema.safeParse({ ...dispatchRequested, legs: [] }).success).toBe(false);
    const badAccount = structuredClone(dispatchRequested);
    badAccount.legs[0]!.account = "buyer" as never; // refunds ride payment.funds-released, not dispatch
    expect(PaymentDispatchRequestedSchema.safeParse(badAccount).success).toBe(false);
    const badAmount = structuredClone(dispatchRequested);
    badAmount.legs[0]!.amountKobo = -5;
    expect(PaymentDispatchRequestedSchema.safeParse(badAmount).success).toBe(false);
    expect(PaymentDispatchRequestedSchema.safeParse({ ...dispatchRequested, idempotencyKey: "" }).success).toBe(false);
  });
});

describe("PaymentDispatchView schema (ops read model)", () => {
  const view = {
    id: "run:cart:Balogun:buyer:1:dispatch:0",
    idempotencyKey: "settlement:run:cart:Balogun:buyer:1:settlement:leg:0",
    settlementRecordId: "run:cart:Balogun:buyer:1:settlement",
    runId: "run:cart:Balogun:buyer:1",
    market: "Balogun",
    account: "seller",
    partyId: "seller:amina",
    amountKobo: 165_000,
    memo: "Seller settlement",
    status: "sent",
    providerRef: "stub:0123456789abcdef01234567",
    failureReason: null,
    attempts: 1,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_500,
  };

  it("round-trips a dispatch row view", () => {
    const parsed = roundTrip(PaymentDispatchViewSchema, view);
    expect(parsed.providerRef).toMatch(/^stub:/);
    expect(parsed.status).toBe("sent");
  });

  it("accepts null providerRef (pending/failed rows) and rejects bad statuses", () => {
    expect(PaymentDispatchViewSchema.safeParse({ ...view, status: "pending", providerRef: null }).success).toBe(true);
    expect(PaymentDispatchViewSchema.safeParse({ ...view, status: "moved" }).success).toBe(false);
  });
});
