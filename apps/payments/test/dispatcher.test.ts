import { describe, expect, it } from "vitest";
import { resolveDispatcher, StubDispatcher } from "../src/dispatcher.js";

describe("StubDispatcher", () => {
  const request = {
    idempotencyKey: "settlement:run:cart:Balogun:buyer:1:settlement:leg:0",
    recipient: { partyId: "seller:amina", account: "seller" as const },
    amountKobo: 165_000,
    memo: "Seller settlement",
  };

  it("always succeeds with a stub: providerRef", async () => {
    const dispatcher = new StubDispatcher();
    const result = await dispatcher.dispatchTransfer(request);
    expect(result.status).toBe("sent");
    expect(result.providerRef).toMatch(/^stub:[0-9a-f]{24}$/);
    expect(result.failureReason).toBeUndefined();
  });

  it("is deterministic: the same transfer yields the same providerRef", async () => {
    const dispatcher = new StubDispatcher();
    const first = await dispatcher.dispatchTransfer(request);
    const second = await dispatcher.dispatchTransfer(request);
    const third = await dispatcher.dispatchTransfer({ ...request });
    expect(second.providerRef).toBe(first.providerRef);
    expect(third.providerRef).toBe(first.providerRef);
  });

  it("distinguishes transfers by key, recipient, and amount", async () => {
    const dispatcher = new StubDispatcher();
    const base = (await dispatcher.dispatchTransfer(request)).providerRef;
    const otherKey = (await dispatcher.dispatchTransfer({ ...request, idempotencyKey: `${request.idempotencyKey}x` })).providerRef;
    const otherParty = (await dispatcher.dispatchTransfer({ ...request, recipient: { partyId: "seller:bola", account: "seller" } })).providerRef;
    const otherAmount = (await dispatcher.dispatchTransfer({ ...request, amountKobo: 165_001 })).providerRef;
    expect(new Set([base, otherKey, otherParty, otherAmount]).size).toBe(4);
  });
});

describe("resolveDispatcher", () => {
  it("defaults to the dev-stage stub and refuses unknown kinds", () => {
    expect(resolveDispatcher({})).toBeInstanceOf(StubDispatcher);
    expect(resolveDispatcher({ PAYMENT_DISPATCHER: "stub" })).toBeInstanceOf(StubDispatcher);
    expect(() => resolveDispatcher({ PAYMENT_DISPATCHER: "acme-pay" })).toThrow(/unknown PAYMENT_DISPATCHER/);
  });

  it("kind 'flutterwave' without FLUTTERWAVE_SECRET_KEY surfaces the vendor config throw (fail fast)", () => {
    expect(() => resolveDispatcher({ PAYMENT_DISPATCHER: "flutterwave" })).toThrow(/FLUTTERWAVE_SECRET_KEY/);
  });
});
