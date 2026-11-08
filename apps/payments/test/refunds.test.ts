import { describe, expect, it } from "vitest";
import type {
  ChargeGateway,
  ChargeRefundReconciliationResult,
  ChargeRefundResult,
  ChargeVerification,
} from "../src/gateway.js";
import { createPaymentsApp } from "../src/index.js";
import { StubDispatcher } from "../src/dispatcher.js";
import {
  FakeMessage,
  InMemoryDispatchStore,
  InMemoryHoldStore,
  InMemoryRefundStore,
  InMemorySettlementStore,
  sampleDispatchRequest,
  sampleHold,
  sampleRefundRequest,
  sampleSettlementAuthorization,
} from "./helpers.js";

/**
 * The refund rail: payment.refund-requested executes the settlement's
 * buyerRefundKobo against the run's hold. Card refunds ride the provider's
 * refund API; non-card methods are honestly refund-manual; failures retry
 * with backoff (the queue's max_retries + DLQ absorb the rest).
 */

class ScriptedGateway implements ChargeGateway {
  refundCalls: Array<{ providerTxId: string; amountKobo: number | null; comments: string }> = [];
  reconcileCalls: Array<{ providerTxId: string; amountKobo: number; comments: string }> = [];
  constructor(
    private readonly result: ChargeRefundResult | ChargeRefundResult[],
    private readonly refundable = true,
    private readonly reconciliation: ChargeRefundReconciliationResult | ChargeRefundReconciliationResult[] = { status: "not-found" },
  ) {}
  async verifyCharge(): Promise<ChargeVerification | null> {
    throw new Error("not used in refund tests");
  }
  async refundCharge(providerTxId: string, amountKobo: number | null, comments: string): Promise<ChargeRefundResult> {
    this.refundCalls.push({ providerTxId, amountKobo, comments });
    if (!Array.isArray(this.result)) return this.result;
    return this.result[Math.min(this.refundCalls.length - 1, this.result.length - 1)]!;
  }
  async reconcileRefund(query: { providerTxId: string; amountKobo: number; comments: string }) {
    this.reconcileCalls.push(query);
    if (!Array.isArray(this.reconciliation)) return this.reconciliation;
    return this.reconciliation[Math.min(this.reconcileCalls.length - 1, this.reconciliation.length - 1)]!;
  }
  supportsRefund(): boolean {
    return this.refundable;
  }
  async listBanks() {
    return [];
  }
  async resolveAccount() {
    return null;
  }
}

function appWith(
  holds: InMemoryHoldStore,
  refunds: InMemoryRefundStore,
  gateway: ChargeGateway | null,
  buyerRefundKobo = 100_000,
) {
  const settlement = sampleSettlementAuthorization();
  settlement.outcome.buyerRefundKobo = buyerRefundKobo;
  return createPaymentsApp(new InMemoryDispatchStore(), new StubDispatcher(), {
    collections: { holds, refunds, gateway },
    settlements: new InMemorySettlementStore([settlement]),
  });
}

async function queueRefund(
  worker: ReturnType<typeof createPaymentsApp>,
  message: FakeMessage,
) {
  await worker.queue({ messages: [message] } as unknown as Parameters<ReturnType<typeof createPaymentsApp>["queue"]>[0]);
}

describe("payment.refund-requested consumer", () => {
  it("card hold: partial refund rides the provider API and the hold goes partially-refunded", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold()); // 335_000 hold, card
    const refunds = new InMemoryRefundStore();
    const gateway = new ScriptedGateway({ status: "processing", providerRef: "flw-refund:12" });
    const worker = appWith(holds, refunds, gateway);

    const message = new FakeMessage("m1", JSON.stringify(sampleRefundRequest({ amountKobo: 100_000 })));
    await queueRefund(worker, message);

    expect(message.acked).toBe(true);
    expect(message.retries).toHaveLength(0);
    expect(gateway.refundCalls).toEqual([
      { providerTxId: "9049104", amountKobo: 100_000, comments: "Buyer refund run:cart:Balogun:buyer:1:settlement" },
    ]);
    const row = await refunds.bySettlementRecordId("run:cart:Balogun:buyer:1:settlement");
    expect(row).toMatchObject({ status: "processing", providerRef: "flw-refund:12", attempts: 1 });
    expect((await holds.byId("hold:mr-cart-1-abc"))?.status).toBe("partially-refunded");
  });

  it("a full-amount refund omits the partial amount and marks the hold refunded", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    const refunds = new InMemoryRefundStore();
    const gateway = new ScriptedGateway({ status: "processing", providerRef: "flw-refund:77" });
    const worker = appWith(holds, refunds, gateway, 335_000);

    const message = new FakeMessage("m1", JSON.stringify(sampleRefundRequest({ amountKobo: 335_000 })));
    await queueRefund(worker, message);

    expect(message.acked).toBe(true);
    expect(gateway.refundCalls[0]?.amountKobo).toBeNull(); // provider full-refund semantics
    expect((await holds.byId("hold:mr-cart-1-abc"))?.status).toBe("refunded");
  });

  it("non-card hold: refund-manual, terminal, and the hold status stays honest", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold({ paymentMethod: "bank_transfer" }));
    const refunds = new InMemoryRefundStore();
    const gateway = new ScriptedGateway({ status: "processing" }, false);
    const worker = appWith(holds, refunds, gateway);

    const message = new FakeMessage("m1", JSON.stringify(sampleRefundRequest()));
    await queueRefund(worker, message);

    expect(message.acked).toBe(true);
    expect(message.retries).toHaveLength(0);
    expect(gateway.refundCalls).toHaveLength(0); // no API call for a method without a rail
    const row = await refunds.bySettlementRecordId("run:cart:Balogun:buyer:1:settlement");
    expect(row?.status).toBe("refund-manual");
    expect(row?.failureReason).toContain("bank_transfer");
    // No money moved: the hold stays held, visible for ops.
    expect((await holds.byId("hold:mr-cart-1-abc"))?.status).toBe("held");
  });

  it("a failed provider call retries with backoff and the row stays failed", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    const refunds = new InMemoryRefundStore();
    const gateway = new ScriptedGateway({ status: "failed", failureReason: "insufficient balance" });
    const worker = appWith(holds, refunds, gateway);

    const message = new FakeMessage("m1", JSON.stringify(sampleRefundRequest()));
    await queueRefund(worker, message);

    expect(message.acked).toBe(false);
    expect(message.retries).toEqual([{ delaySeconds: 30 }]);
    expect((await refunds.bySettlementRecordId("run:cart:Balogun:buyer:1:settlement"))?.status).toBe("failed");
    expect((await holds.byId("hold:mr-cart-1-abc"))?.status).toBe("held");
  });

  it("redelivery after success is a no-op replay (never a double refund)", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    const refunds = new InMemoryRefundStore();
    const gateway = new ScriptedGateway({ status: "processing", providerRef: "flw-refund:12" });
    const worker = appWith(holds, refunds, gateway);

    await queueRefund(worker, new FakeMessage("m1", JSON.stringify(sampleRefundRequest())));
    await queueRefund(worker, new FakeMessage("m2", JSON.stringify(sampleRefundRequest())));

    expect(gateway.refundCalls).toHaveLength(1);
    expect(refunds.rows.size).toBe(1);
  });

  it("retries without side effects when the durable settlement is not visible yet", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    const refunds = new InMemoryRefundStore();
    const gateway = new ScriptedGateway({ status: "processing" });
    const worker = createPaymentsApp(new InMemoryDispatchStore(), new StubDispatcher(), {
      collections: { holds, refunds, gateway },
      settlements: new InMemorySettlementStore([]),
    });

    const message = new FakeMessage("m1", JSON.stringify(sampleRefundRequest()));
    await queueRefund(worker, message);

    expect(message.acked).toBe(false);
    expect(message.retries).toEqual([{ delaySeconds: 30 }]);
    expect(gateway.refundCalls).toHaveLength(0);
    expect(refunds.rows.size).toBe(0);
    expect((await holds.byId(sampleHold().id))?.status).toBe("held");
  });

  it.each([
    ["run", { runId: "run:cart:Balogun:buyer:other" }],
    ["buyer", { buyerId: "buyer:attacker" }],
    ["amount", { amountKobo: 335_000 }],
  ])("rejects a refund replay with a changed %s before provider execution", async (_field, overrides) => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    const refunds = new InMemoryRefundStore();
    const gateway = new ScriptedGateway({ status: "processing" });
    const worker = appWith(holds, refunds, gateway);
    await queueRefund(worker, new FakeMessage("m1", JSON.stringify(sampleRefundRequest())));

    const replay = new FakeMessage("m2", JSON.stringify(sampleRefundRequest(overrides)));
    await queueRefund(worker, replay);

    expect(replay.acked).toBe(true);
    expect(replay.retries).toHaveLength(0);
    expect(gateway.refundCalls).toHaveLength(1);
    expect(refunds.rows.size).toBe(1);
    expect((await refunds.bySettlementRecordId(sampleRefundRequest().settlementRecordId))?.amountKobo).toBe(100_000);
  });

  it("refuses a canonical replay through a tampered stored refund row", async () => {
    const holds = new InMemoryHoldStore();
    const hold = sampleHold();
    await holds.insertIfAbsent(hold);
    const refunds = new InMemoryRefundStore();
    const request = sampleRefundRequest();
    await refunds.insertPending({
      id: `refund:${request.settlementRecordId}`,
      holdId: hold.id,
      settlementRecordId: request.settlementRecordId,
      amountKobo: 1,
      status: "failed",
      providerRef: null,
      failureReason: "legacy row",
      attempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      resolution: null,
    });
    const gateway = new ScriptedGateway({ status: "processing" });
    const worker = appWith(holds, refunds, gateway);

    const message = new FakeMessage("m1", JSON.stringify(request));
    await queueRefund(worker, message);

    expect(message.acked).toBe(false);
    expect(message.retries).toEqual([{ delaySeconds: 30 }]);
    expect(gateway.refundCalls).toHaveLength(0);
    expect((await refunds.bySettlementRecordId(request.settlementRecordId))?.amountKobo).toBe(1);
  });

  it("acks without a refund row when no hold exists for the run (ungated collection)", async () => {
    const refunds = new InMemoryRefundStore();
    const worker = appWith(new InMemoryHoldStore(), refunds, new ScriptedGateway({ status: "processing" }));

    const message = new FakeMessage("m1", JSON.stringify(sampleRefundRequest()));
    await queueRefund(worker, message);

    expect(message.acked).toBe(true);
    expect(refunds.rows.size).toBe(0);
  });

  it("fails honestly and retries when no collection gateway is configured (stub posture)", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    const refunds = new InMemoryRefundStore();
    const worker = appWith(holds, refunds, null);

    const message = new FakeMessage("m1", JSON.stringify(sampleRefundRequest()));
    await queueRefund(worker, message);

    expect(message.acked).toBe(false);
    expect(message.retries).toHaveLength(1);
    const row = await refunds.bySettlementRecordId("run:cart:Balogun:buyer:1:settlement");
    expect(row?.status).toBe("failed");
    expect(row?.failureReason).toContain("collection-unavailable");
  });

  it("preserves an ambiguous failure when a redelivery has no gateway", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    const refunds = new InMemoryRefundStore();
    const body = JSON.stringify(sampleRefundRequest());
    await queueRefund(
      appWith(holds, refunds, new ScriptedGateway({ status: "indeterminate", failureReason: "provider-unreachable: timeout" })),
      new FakeMessage("m1", body),
    );

    const unavailable = new FakeMessage("m2", body);
    await queueRefund(appWith(holds, refunds, null), unavailable);

    expect(unavailable.retries).toHaveLength(1);
    expect((await refunds.bySettlementRecordId(sampleRefundRequest().settlementRecordId))?.failureReason)
      .toBe("provider-unreachable: timeout");
  });

  it("refuses to refund beyond the hold (never clamped — a money decision)", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    const refunds = new InMemoryRefundStore();
    const gateway = new ScriptedGateway({ status: "processing", providerRef: "flw-refund:12" });
    const worker = appWith(holds, refunds, gateway, 400_000);

    const message = new FakeMessage("m1", JSON.stringify(sampleRefundRequest({ amountKobo: 400_000 })));
    await queueRefund(worker, message);

    expect(gateway.refundCalls).toHaveLength(0);
    const row = await refunds.bySettlementRecordId("run:cart:Balogun:buyer:1:settlement");
    expect(row?.status).toBe("failed");
    expect(row?.failureReason).toContain("refund-exceeds-hold");
  });

  it("a successful dispatch release marks the run's hold released (held → released)", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    const refunds = new InMemoryRefundStore();
    const worker = appWith(holds, refunds, new ScriptedGateway({ status: "processing" }));

    const message = new FakeMessage("m1", JSON.stringify(sampleDispatchRequest()));
    await queueRefund(worker, message);

    expect(message.acked).toBe(true);
    expect((await holds.byId("hold:mr-cart-1-abc"))?.status).toBe("released");
  });

  it("splits a refund across top-up holds and replay never double-refunds", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    await holds.insertIfAbsent(sampleHold({ id: "hold:topup", txRef: "mr-topup", providerTxId: "topup-provider", amountKobo: 100_000 }));
    const refunds = new InMemoryRefundStore();
    const gateway = new ScriptedGateway({ status: "processing", providerRef: "flw-refund:multi" });
    const worker = appWith(holds, refunds, gateway, 400_000);
    const body = JSON.stringify(sampleRefundRequest({ amountKobo: 400_000 }));

    const first = new FakeMessage("m1", body);
    await queueRefund(worker, first);
    expect(first.acked).toBe(true);
    expect(gateway.refundCalls).toEqual([
      { providerTxId: "9049104", amountKobo: null, comments: "Buyer refund run:cart:Balogun:buyer:1:settlement" },
      { providerTxId: "topup-provider", amountKobo: 65_000, comments: "Buyer refund run:cart:Balogun:buyer:1:settlement" },
    ]);
    expect((await holds.byId("hold:mr-cart-1-abc"))?.status).toBe("refunded");
    expect((await holds.byId("hold:topup"))?.status).toBe("partially-refunded");

    const replay = new FakeMessage("m2", body);
    await queueRefund(worker, replay);
    expect(replay.acked).toBe(true);
    expect(gateway.refundCalls).toHaveLength(2);
    expect(await refunds.forSettlement("run:cart:Balogun:buyer:1:settlement")).toHaveLength(2);
  });

  it.each([
    [100_000, 100_000, "partially-refunded"],
    [335_000, null, "refunded"],
  ])("an ambiguous %s-kobo refund adopts an exact provider match without a second POST", async (amountKobo, providerAmount, holdStatus) => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    const refunds = new InMemoryRefundStore();
    const gateway = new ScriptedGateway(
      { status: "indeterminate", failureReason: "provider-unreachable: timeout" },
      true,
      { status: "found", refund: { status: "processing", providerRef: "flw-refund:adopted" } },
    );
    const worker = appWith(holds, refunds, gateway, amountKobo);
    const body = JSON.stringify(sampleRefundRequest({ amountKobo }));

    const first = new FakeMessage("m1", body);
    await queueRefund(worker, first);
    expect(first.retries).toEqual([{ delaySeconds: 30 }]);
    expect(first.acked).toBe(false);
    expect(gateway.reconcileCalls).toHaveLength(0);
    expect((await refunds.bySettlementRecordId(sampleRefundRequest().settlementRecordId))?.status).toBe("failed");

    const second = new FakeMessage("m2", body);
    await queueRefund(worker, second);
    expect(second.acked).toBe(true);
    expect(second.retries).toHaveLength(0);
    expect(gateway.refundCalls).toEqual([{
      providerTxId: "9049104",
      amountKobo: providerAmount,
      comments: "Buyer refund run:cart:Balogun:buyer:1:settlement",
    }]);
    expect(gateway.reconcileCalls).toEqual([{
      providerTxId: "9049104",
      amountKobo,
      comments: "Buyer refund run:cart:Balogun:buyer:1:settlement",
    }]);
    expect((await refunds.bySettlementRecordId(sampleRefundRequest().settlementRecordId))).toMatchObject({
      status: "processing",
      providerRef: "flw-refund:adopted",
      failureReason: null,
    });
    expect((await holds.byId(sampleHold().id))?.status).toBe(holdStatus);
  });

  it("permits one new POST when reconciliation finds no accepted refund", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    const refunds = new InMemoryRefundStore();
    const gateway = new ScriptedGateway([
      { status: "indeterminate", failureReason: "provider-response-missing-refund" },
      { status: "processing", providerRef: "flw-refund:new" },
    ]);
    const worker = appWith(holds, refunds, gateway);
    const body = JSON.stringify(sampleRefundRequest());

    await queueRefund(worker, new FakeMessage("m1", body));
    const second = new FakeMessage("m2", body);
    await queueRefund(worker, second);

    expect(second.acked).toBe(true);
    expect(gateway.reconcileCalls).toHaveLength(1);
    expect(gateway.refundCalls).toHaveLength(2);
    expect((await refunds.bySettlementRecordId(sampleRefundRequest().settlementRecordId))).toMatchObject({
      status: "processing",
      providerRef: "flw-refund:new",
    });
  });

  it("retries lookup only after reconciliation failures, then adopts without a POST", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    const refunds = new InMemoryRefundStore();
    const gateway = new ScriptedGateway(
      { status: "indeterminate", failureReason: "provider-response-unparseable: HTTP 502" },
      true,
      [
        { status: "indeterminate", failureReason: "reconciliation-provider-unreachable: offline" },
        { status: "found", refund: { status: "processing", providerRef: "flw-refund:adopted" } },
      ],
    );
    const worker = appWith(holds, refunds, gateway);
    const body = JSON.stringify(sampleRefundRequest());

    await queueRefund(worker, new FakeMessage("m1", body));
    const lookupFailed = new FakeMessage("m2", body);
    await queueRefund(worker, lookupFailed);
    expect(lookupFailed.retries).toHaveLength(1);
    expect(gateway.refundCalls).toHaveLength(1);
    expect((await refunds.bySettlementRecordId(sampleRefundRequest().settlementRecordId))?.failureReason)
      .toContain("reconciliation-provider-unreachable");

    const adopted = new FakeMessage("m3", body);
    await queueRefund(worker, adopted);
    expect(adopted.acked).toBe(true);
    expect(gateway.refundCalls).toHaveLength(1);
    expect(gateway.reconcileCalls).toHaveLength(2);
  });

  it("persists refund-review on conflict and makes later redelivery and Ops filtering inert", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    const refunds = new InMemoryRefundStore();
    const gateway = new ScriptedGateway(
      { status: "indeterminate", failureReason: "provider-unreachable: timeout" },
      true,
      { status: "conflict", failureReason: "reconciliation-conflict: multiple exact accepted refunds" },
    );
    const worker = appWith(holds, refunds, gateway);
    const body = JSON.stringify(sampleRefundRequest());

    await queueRefund(worker, new FakeMessage("m1", body));
    const review = new FakeMessage("m2", body);
    await queueRefund(worker, review);
    expect(review.acked).toBe(true);
    expect(review.retries).toHaveLength(0);
    expect((await refunds.bySettlementRecordId(sampleRefundRequest().settlementRecordId))?.status).toBe("refund-review");

    const replay = new FakeMessage("m3", body);
    await queueRefund(worker, replay);
    expect(replay.acked).toBe(true);
    expect(gateway.refundCalls).toHaveLength(1);
    expect(gateway.reconcileCalls).toHaveLength(1);

    const ops = await worker.fetch(new Request("http://payments/payments/refunds?status=refund-review"));
    expect(ops.status).toBe(200);
    expect(((await ops.json()) as { total: number }).total).toBe(1);
  });

  it("does not repeat an earlier processing hold while reconciling a later ambiguous hold", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    await holds.insertIfAbsent(sampleHold({ id: "hold:topup", txRef: "mr-topup", providerTxId: "topup-provider", amountKobo: 100_000 }));
    const refunds = new InMemoryRefundStore();
    const gateway = new ScriptedGateway(
      [
        { status: "processing", providerRef: "flw-refund:first" },
        { status: "indeterminate", failureReason: "provider-unreachable: timeout" },
      ],
      true,
      { status: "found", refund: { status: "processing", providerRef: "flw-refund:second" } },
    );
    const worker = appWith(holds, refunds, gateway, 400_000);
    const body = JSON.stringify(sampleRefundRequest({ amountKobo: 400_000 }));

    await queueRefund(worker, new FakeMessage("m1", body));
    const replay = new FakeMessage("m2", body);
    await queueRefund(worker, replay);

    expect(replay.acked).toBe(true);
    expect(gateway.refundCalls).toHaveLength(2);
    expect(gateway.reconcileCalls).toEqual([{
      providerTxId: "topup-provider",
      amountKobo: 65_000,
      comments: "Buyer refund run:cart:Balogun:buyer:1:settlement",
    }]);
    expect((await refunds.byId("refund:run:cart:Balogun:buyer:1:settlement:hold:mr-cart-1-abc"))?.providerRef).toBe("flw-refund:first");
    expect((await refunds.byId("refund:run:cart:Balogun:buyer:1:settlement:hold:topup"))?.providerRef).toBe("flw-refund:second");
  });

  it("keeps explicit provider rejections on the existing retry path without reconciliation", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    const refunds = new InMemoryRefundStore();
    const gateway = new ScriptedGateway({ status: "failed", failureReason: "Transaction already fully refunded" });
    const worker = appWith(holds, refunds, gateway);
    const body = JSON.stringify(sampleRefundRequest());

    await queueRefund(worker, new FakeMessage("m1", body));
    await queueRefund(worker, new FakeMessage("m2", body));

    expect(gateway.refundCalls).toHaveLength(2);
    expect(gateway.reconcileCalls).toHaveLength(0);
  });

  it("a failed dispatch leg does NOT release the hold", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    const refunds = new InMemoryRefundStore();
    const failing = new (class extends StubDispatcher {
      override async dispatchTransfer() {
        return { status: "failed" as const, failureReason: "boom" };
      }
    })();
    const worker = createPaymentsApp(new InMemoryDispatchStore(), failing, {
      collections: { holds, refunds, gateway: null },
      settlements: new InMemorySettlementStore(),
    });

    const message = new FakeMessage("m1", JSON.stringify(sampleDispatchRequest()));
    await queueRefund(worker, message);

    expect(message.retries).toHaveLength(1);
    expect((await holds.byId("hold:mr-cart-1-abc"))?.status).toBe("held");
  });
});
