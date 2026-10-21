import { describe, expect, it } from "vitest";
import type { ChargeGateway, ChargeRefundResult, ChargeVerification } from "../src/gateway.js";
import { createPaymentsApp } from "../src/index.js";
import { StubDispatcher } from "../src/dispatcher.js";
import {
  FakeMessage,
  InMemoryDispatchStore,
  InMemoryHoldStore,
  InMemoryRefundStore,
  sampleHold,
  sampleRefundRequest,
} from "./helpers.js";

/**
 * The refund rail: payment.refund-requested executes the settlement's
 * buyerRefundKobo against the run's hold. Card refunds ride the provider's
 * refund API; non-card methods are honestly refund-manual; failures retry
 * with backoff (the queue's max_retries + DLQ absorb the rest).
 */

class ScriptedGateway implements ChargeGateway {
  refundCalls: Array<{ providerTxId: string; amountKobo: number | null; comments: string }> = [];
  constructor(
    private readonly result: ChargeRefundResult,
    private readonly refundable = true,
  ) {}
  async verifyCharge(): Promise<ChargeVerification | null> {
    throw new Error("not used in refund tests");
  }
  async refundCharge(providerTxId: string, amountKobo: number | null, comments: string): Promise<ChargeRefundResult> {
    this.refundCalls.push({ providerTxId, amountKobo, comments });
    return this.result;
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
) {
  return createPaymentsApp(new InMemoryDispatchStore(), new StubDispatcher(), {
    collections: { holds, refunds, gateway },
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
    const worker = appWith(holds, refunds, gateway);

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

  it("refuses to refund beyond the hold (never clamped — a money decision)", async () => {
    const holds = new InMemoryHoldStore();
    await holds.insertIfAbsent(sampleHold());
    const refunds = new InMemoryRefundStore();
    const gateway = new ScriptedGateway({ status: "processing", providerRef: "flw-refund:12" });
    const worker = appWith(holds, refunds, gateway);

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

    const dispatchBody = {
      type: "payment.dispatch-requested",
      settlementRecordId: "run:cart:Balogun:buyer:1:settlement",
      runId: "run:cart:Balogun:buyer:1",
      market: "Balogun",
      legs: [{ account: "seller", partyId: "seller:amina", amountKobo: 165_000, memo: "Seller settlement" }],
      idempotencyKey: "settlement:run:cart:Balogun:buyer:1:settlement",
    };
    const message = new FakeMessage("m1", JSON.stringify(dispatchBody));
    await queueRefund(worker, message);

    expect(message.acked).toBe(true);
    expect((await holds.byId("hold:mr-cart-1-abc"))?.status).toBe("released");
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
    });

    const dispatchBody = {
      type: "payment.dispatch-requested",
      settlementRecordId: "run:cart:Balogun:buyer:1:settlement",
      runId: "run:cart:Balogun:buyer:1",
      market: "Balogun",
      legs: [{ account: "seller", partyId: "seller:amina", amountKobo: 165_000, memo: "Seller settlement" }],
      idempotencyKey: "settlement:run:cart:Balogun:buyer:1:settlement",
    };
    const message = new FakeMessage("m1", JSON.stringify(dispatchBody));
    await queueRefund(worker, message);

    expect(message.retries).toHaveLength(1);
    expect((await holds.byId("hold:mr-cart-1-abc"))?.status).toBe("held");
  });
});
