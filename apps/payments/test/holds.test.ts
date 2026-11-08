import { describe, expect, it } from "vitest";
import type { ChargeGateway, ChargeRefundResult, ChargeVerification } from "../src/gateway.js";
import { createPaymentsApp } from "../src/index.js";
import { StubDispatcher } from "../src/dispatcher.js";
import {
  InMemoryDispatchStore,
  InMemoryHoldStore,
  InMemoryRefundStore,
  sampleHold,
} from "./helpers.js";

/**
 * Charge confirmation + holds: the provider verify API is the only truth —
 * client amounts are a cross-check, webhooks are hints. Confirmation is
 * idempotent on txRef.
 */

class FakeGateway implements ChargeGateway {
  verifyCalls = 0;
  constructor(private readonly verification: ChargeVerification | null) {}
  async verifyCharge(): Promise<ChargeVerification | null> {
    this.verifyCalls += 1;
    return this.verification;
  }
  async refundCharge(): Promise<ChargeRefundResult> {
    throw new Error("not used in holds tests");
  }
  async reconcileRefund() {
    return { status: "not-found" as const };
  }
  supportsRefund(paymentMethod: string): boolean {
    return paymentMethod === "card";
  }
  async listBanks() {
    return [];
  }
  async resolveAccount() {
    return null;
  }
}

const VERIFIED: ChargeVerification = {
  txRef: "mr-cart-1-abc",
  providerTxId: "9049104",
  amountKobo: 335_000,
  currency: "NGN",
  paymentMethod: "card",
  status: "successful",
};

function confirmRequest(overrides: Record<string, unknown> = {}) {
  return {
    txRef: "mr-cart-1-abc",
    expectedAmountKobo: 335_000,
    buyerId: "buyer:1",
    cartId: "cart:Balogun:buyer:1",
    ...overrides,
  };
}

function app(gateway: ChargeGateway | null, holds = new InMemoryHoldStore(), refunds = new InMemoryRefundStore()) {
  return createPaymentsApp(new InMemoryDispatchStore(), new StubDispatcher(), {
    collections: { holds, refunds, gateway },
  });
}

function post(path: string, body: unknown) {
  return new Request(`http://payments${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /payments/charges/confirm", () => {
  it("verifies server-side and places a hold", async () => {
    const gateway = new FakeGateway(VERIFIED);
    const response = await app(gateway).fetch(post("/payments/charges/confirm", confirmRequest()));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { holdId: string; status: string; amountKobo: number; txRef: string };
    expect(body).toEqual({ holdId: "hold:mr-cart-1-abc", txRef: "mr-cart-1-abc", amountKobo: 335_000, status: "held" });
    expect(gateway.verifyCalls).toBe(1);
  });

  it("supports verification by transactionId", async () => {
    const gateway = new FakeGateway(VERIFIED);
    const { txRef: _txRef, ...rest } = confirmRequest();
    const response = await app(gateway).fetch(post("/payments/charges/confirm", { ...rest, transactionId: 9049104 }));
    expect(response.status).toBe(200);
  });

  it("rejects an amount mismatch (client amounts are never trusted)", async () => {
    const response = await app(new FakeGateway(VERIFIED)).fetch(
      post("/payments/charges/confirm", confirmRequest({ expectedAmountKobo: 300_000 })),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe("amount-mismatch");
  });

  it("rejects a non-successful charge and a wrong currency", async () => {
    const pending = await app(new FakeGateway({ ...VERIFIED, status: "pending" })).fetch(
      post("/payments/charges/confirm", confirmRequest()),
    );
    expect(pending.status).toBe(409);
    expect(((await pending.json()) as { error: string }).error).toBe("charge-not-successful");

    const dollars = await app(new FakeGateway({ ...VERIFIED, currency: "USD" })).fetch(
      post("/payments/charges/confirm", confirmRequest()),
    );
    expect(dollars.status).toBe(409);
    expect(((await dollars.json()) as { error: string }).error).toBe("currency-mismatch");
  });

  it("404s when the provider does not know the charge", async () => {
    const response = await app(new FakeGateway(null)).fetch(post("/payments/charges/confirm", confirmRequest()));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("charge-not-found");
  });

  it("is idempotent on txRef: a replay returns the existing hold without re-verifying", async () => {
    const gateway = new FakeGateway(VERIFIED);
    const holds = new InMemoryHoldStore();
    const worker = app(gateway, holds);
    const first = await worker.fetch(post("/payments/charges/confirm", confirmRequest()));
    expect(first.status).toBe(200);
    const replay = await worker.fetch(post("/payments/charges/confirm", confirmRequest()));
    expect(replay.status).toBe(200);
    expect(gateway.verifyCalls).toBe(1); // no second verify call
    expect(holds.rows.size).toBe(1);
  });

  it("conflicts when the txRef already holds a different cart/buyer", async () => {
    const worker = app(new FakeGateway(VERIFIED));
    expect((await worker.fetch(post("/payments/charges/confirm", confirmRequest()))).status).toBe(200);
    const conflict = await worker.fetch(
      post("/payments/charges/confirm", confirmRequest({ cartId: "cart:Balogun:buyer:2", buyerId: "buyer:2" })),
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toBe("hold-conflict");
  });

  it("503s without a collection provider (stub dispatcher posture)", async () => {
    const response = await app(null).fetch(post("/payments/charges/confirm", confirmRequest()));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe("collection-unavailable");
  });

  it("400s on a schema-invalid body", async () => {
    const response = await app(new FakeGateway(VERIFIED)).fetch(
      post("/payments/charges/confirm", { expectedAmountKobo: 1 }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid-request");
  });
});

describe("holds reads + run binding", () => {
  async function seeded() {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold({ runId: null }));
    return holds;
  }

  it("GET /payments/holds/:txRef returns the hold, 404 when unknown", async () => {
    const holds = await seeded();
    const worker = app(new FakeGateway(VERIFIED), holds);
    const found = await worker.fetch(new Request("http://payments/payments/holds/mr-cart-1-abc"));
    expect(found.status).toBe(200);
    const view = (await found.json()) as { id: string; status: string; runId: string | null };
    expect(view.id).toBe("hold:mr-cart-1-abc");
    expect(view.runId).toBeNull();
    expect((await worker.fetch(new Request("http://payments/payments/holds/nope"))).status).toBe(404);
  });

  it("POST /payments/holds/:txRef/bind binds once, idempotent on the same runId, conflict on another", async () => {
    const holds = await seeded();
    const worker = app(new FakeGateway(VERIFIED), holds);

    const bound = await worker.fetch(post("/payments/holds/mr-cart-1-abc/bind", { runId: "run:cart:Balogun:buyer:1" }));
    expect(bound.status).toBe(200);
    expect(((await bound.json()) as { status: string }).status).toBe("bound");

    const again = await worker.fetch(post("/payments/holds/mr-cart-1-abc/bind", { runId: "run:cart:Balogun:buyer:1" }));
    expect(((await again.json()) as { status: string }).status).toBe("already-bound");

    const other = await worker.fetch(post("/payments/holds/mr-cart-1-abc/bind", { runId: "run:cart:Balogun:buyer:9" }));
    expect(other.status).toBe(409);
  });

  it("GET /payments/holds lists with filters; GET /payments/refunds lists", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    await holds.insertIfAbsent(sampleHold({ id: "hold:other", txRef: "other", buyerId: "buyer:2", status: "refunded" }));
    const worker = app(new FakeGateway(VERIFIED), holds);

    const all = await worker.fetch(new Request("http://payments/payments/holds"));
    expect(((await all.json()) as { total: number }).total).toBe(2);

    const byBuyer = await worker.fetch(new Request("http://payments/payments/holds?buyerId=buyer:2&status=refunded"));
    expect(((await byBuyer.json()) as { total: number }).total).toBe(1);

    const badStatus = await worker.fetch(new Request("http://payments/payments/holds?status=bogus"));
    expect(badStatus.status).toBe(400);

    const refunds = await worker.fetch(new Request("http://payments/payments/refunds"));
    expect(refunds.status).toBe(200);
    expect(((await refunds.json()) as { total: number }).total).toBe(0);
  });
});

describe("charge.completed webhook", () => {
  const SECRET = "webhook-secret";
  const hooks = {
    hashHeader: "verif-hash",
    verify: async (secret: string, presented: string | null) => presented === secret,
    parse: () => ({ kind: "ignored" }) as const,
    parseCharge: (body: unknown) => {
      const b = body as { event?: string; data?: { id?: number; tx_ref?: string; meta?: { cartId?: string; buyerId?: string } } };
      if (b.event !== "charge.completed") return { kind: "ignored" } as const;
      return {
        kind: "charge",
        charge: {
          txRef: b.data?.tx_ref ?? null,
          transactionId: b.data?.id === undefined ? null : String(b.data.id),
          cartId: b.data?.meta?.cartId ?? null,
          buyerId: b.data?.meta?.buyerId ?? null,
        },
      } as const;
    },
  };

  function webhookRequest(body: unknown, hash = SECRET) {
    return new Request("http://payments/webhooks/charges", {
      method: "POST",
      headers: { "content-type": "application/json", "verif-hash": hash },
      body: JSON.stringify(body),
    });
  }

  it("verifies server-side and places the hold from charge meta", async () => {
    const gateway = new FakeGateway(VERIFIED);
    const holds = new InMemoryHoldStore();
    const worker = createPaymentsApp(new InMemoryDispatchStore(), new StubDispatcher(), {
      webhook: { secret: SECRET, hooks },
      collections: { holds, refunds: new InMemoryRefundStore(), gateway },
    });
    const response = await worker.fetch(
      webhookRequest({ event: "charge.completed", data: { id: 9049104, tx_ref: "mr-cart-1-abc", meta: { cartId: "cart:Balogun:buyer:1", buyerId: "buyer:1" } } }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("applied");
    expect(gateway.verifyCalls).toBe(1); // webhook was a hint; verify API decided
    expect(holds.rows.size).toBe(1);
  });

  it("acknowledges without a hold when the charge meta carries no cart/buyer", async () => {
    const gateway = new FakeGateway(VERIFIED);
    const holds = new InMemoryHoldStore();
    const worker = createPaymentsApp(new InMemoryDispatchStore(), new StubDispatcher(), {
      webhook: { secret: SECRET, hooks },
      collections: { holds, refunds: new InMemoryRefundStore(), gateway },
    });
    const response = await worker.fetch(
      webhookRequest({ event: "charge.completed", data: { id: 9049104, tx_ref: "mr-cart-1-abc" } }),
    );
    expect(((await response.json()) as { status: string }).status).toBe("ignored");
    expect(holds.rows.size).toBe(0);
  });

  it("rejects a bad webhook hash with 401", async () => {
    const worker = createPaymentsApp(new InMemoryDispatchStore(), new StubDispatcher(), {
      webhook: { secret: SECRET, hooks },
      collections: { holds: new InMemoryHoldStore(), refunds: new InMemoryRefundStore(), gateway: new FakeGateway(VERIFIED) },
    });
    const response = await worker.fetch(webhookRequest({ event: "charge.completed", data: {} }, "wrong"));
    expect(response.status).toBe(401);
  });
});
