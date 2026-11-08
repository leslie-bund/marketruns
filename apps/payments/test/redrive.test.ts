import { describe, expect, it } from "vitest";
import { createPaymentsApp, type PaymentsAppOptions } from "../src/index.js";
import type { PaymentDispatcher } from "../src/dispatcher.js";
import {
  InMemoryDispatchStore,
  InMemorySettlementStore,
  sampleDispatchRequest,
  sampleRefundRequest,
  sampleSettlementAuthorization,
} from "./helpers.js";

const settlementId = "run:cart:Balogun:buyer:1:settlement";
const redrivePath = `/settlements/${settlementId}/redrive`;
const auth = { "x-payments-internal": "internal-test-token" };

class RecordingQueue implements Pick<Queue, "send"> {
  readonly attempts: unknown[] = [];
  readonly bodies: unknown[] = [];

  constructor(private readonly failingTypes: ReadonlySet<string> = new Set()) {}

  async send(body: unknown): Promise<QueueSendResponse> {
    this.attempts.push(body);
    const type = (JSON.parse(body as string) as { type: string }).type;
    if (this.failingTypes.has(type)) throw new Error(`enqueue failed: ${type}`);
    this.bodies.push(body);
    return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
  }
}

const enqueueOnlyDispatcher: PaymentDispatcher = {
  async dispatchTransfer(): Promise<never> {
    throw new Error("redrive must not execute a dispatch");
  },
};

function redriveApp(queue?: RecordingQueue, overrides: PaymentsAppOptions = {}) {
  return createPaymentsApp(new InMemoryDispatchStore(), enqueueOnlyDispatcher, {
    settlements: new InMemorySettlementStore(),
    participantAuth: { internalToken: "internal-test-token" },
    ...(queue ? { paymentQueue: queue } : {}),
    ...overrides,
  });
}

function redrive(app: ReturnType<typeof createPaymentsApp>, init: RequestInit = {}) {
  return app.fetch(new Request(`http://payments${redrivePath}`, { method: "POST", ...init }));
}

describe("POST /settlements/:settlementRecordId/redrive", () => {
  it("enqueues both canonical settlement messages without executing them", async () => {
    const queue = new RecordingQueue();
    const response = await redrive(redriveApp(queue), { headers: auth });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      settlementRecordId: settlementId,
      runId: "run:cart:Balogun:buyer:1",
      status: "enqueued",
      dispatchLegs: 3,
      refundDue: true,
      dispatchEnqueued: true,
      refundEnqueued: true,
      enqueuedCount: 2,
      failedCount: 0,
    });
    expect(queue.bodies.map((body) => JSON.parse(body as string))).toEqual([
      sampleDispatchRequest(),
      sampleRefundRequest(),
    ]);
  });

  it("attempts the refund independently when dispatch enqueue fails", async () => {
    const queue = new RecordingQueue(new Set(["payment.dispatch-requested"]));
    const response = await redrive(redriveApp(queue), { headers: auth });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      settlementRecordId: settlementId,
      runId: "run:cart:Balogun:buyer:1",
      status: "partial",
      dispatchLegs: 3,
      refundDue: true,
      dispatchEnqueued: false,
      refundEnqueued: true,
      enqueuedCount: 1,
      failedCount: 1,
    });
    expect(queue.attempts.map((body) => JSON.parse(body as string))).toEqual([
      sampleDispatchRequest(),
      sampleRefundRequest(),
    ]);
    expect(queue.bodies.map((body) => JSON.parse(body as string))).toEqual([sampleRefundRequest()]);
  });

  it("reports total failure after attempting both messages", async () => {
    const queue = new RecordingQueue(new Set(["payment.dispatch-requested", "payment.refund-requested"]));
    const response = await redrive(redriveApp(queue), { headers: auth });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      settlementRecordId: settlementId,
      runId: "run:cart:Balogun:buyer:1",
      status: "failed",
      dispatchLegs: 3,
      refundDue: true,
      dispatchEnqueued: false,
      refundEnqueued: false,
      enqueuedCount: 0,
      failedCount: 2,
    });
    expect(queue.attempts.map((body) => JSON.parse(body as string))).toEqual([
      sampleDispatchRequest(),
      sampleRefundRequest(),
    ]);
    expect(queue.bodies).toEqual([]);
  });

  it("enqueues only dispatch when no refund is due", async () => {
    const queue = new RecordingQueue();
    const settlements = new InMemorySettlementStore([
      sampleSettlementAuthorization({
        outcome: {
          sellers: [{ sellerId: "seller:amina", amountKobo: 148_500 }],
          runnerKobo: 160_000,
          platformKobo: 26_500,
          buyerRefundKobo: 0,
          platformLossKobo: 0,
        },
      }),
    ]);
    const response = await redrive(redriveApp(queue, { settlements }), { headers: auth });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "enqueued",
      dispatchLegs: 3,
      refundDue: false,
      dispatchEnqueued: true,
      refundEnqueued: false,
      enqueuedCount: 1,
      failedCount: 0,
    });
    expect(queue.bodies.map((body) => JSON.parse(body as string))).toEqual([sampleDispatchRequest()]);
  });

  it("enqueues only refund when there are no dispatch legs", async () => {
    const queue = new RecordingQueue();
    const settlements = new InMemorySettlementStore([
      sampleSettlementAuthorization({
        outcome: {
          sellers: [],
          runnerKobo: 0,
          platformKobo: 0,
          buyerRefundKobo: 100_000,
          platformLossKobo: 335_000,
        },
      }),
    ]);
    const response = await redrive(redriveApp(queue, { settlements }), { headers: auth });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "enqueued",
      dispatchLegs: 0,
      refundDue: true,
      dispatchEnqueued: false,
      refundEnqueued: true,
      enqueuedCount: 1,
      failedCount: 0,
    });
    expect(queue.bodies.map((body) => JSON.parse(body as string))).toEqual([sampleRefundRequest()]);
  });

  it("returns a zero-message noop without requiring a queue", async () => {
    const settlements = new InMemorySettlementStore([
      sampleSettlementAuthorization({
        outcome: {
          sellers: [],
          runnerKobo: 0,
          platformKobo: 0,
          buyerRefundKobo: 0,
          platformLossKobo: 335_000,
        },
      }),
    ]);
    const response = await redrive(redriveApp(undefined, { settlements }), { headers: auth });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      settlementRecordId: settlementId,
      runId: "run:cart:Balogun:buyer:1",
      status: "noop",
      dispatchLegs: 0,
      refundDue: false,
      dispatchEnqueued: false,
      refundEnqueued: false,
      enqueuedCount: 0,
      failedCount: 0,
    });
  });

  it("returns settlement-not-found for an unknown settlement", async () => {
    const queue = new RecordingQueue();
    const settlements = new InMemorySettlementStore([]);
    const response = await redrive(redriveApp(queue, { settlements }), { headers: auth });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "settlement-not-found" });
    expect(queue.attempts).toEqual([]);
  });

  it("requires valid internal service authentication", async () => {
    const queue = new RecordingQueue();
    const app = redriveApp(queue);
    const missing = await redrive(app);
    const wrong = await redrive(app, { headers: { "x-payments-internal": "forged-token" } });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(queue.attempts).toEqual([]);
  });

  it("fails closed when the settlement store or required queue is unconfigured", async () => {
    const queue = new RecordingQueue();
    const withoutStore = createPaymentsApp(new InMemoryDispatchStore(), enqueueOnlyDispatcher, {
      participantAuth: { internalToken: "internal-test-token" },
      paymentQueue: queue,
    });
    const missingStore = await redrive(withoutStore, { headers: auth });
    const missingQueue = await redrive(redriveApp(), { headers: auth });

    expect(missingStore.status).toBe(503);
    expect(await missingStore.json()).toMatchObject({ error: "settlement-store-unconfigured" });
    expect(missingQueue.status).toBe(503);
    expect(await missingQueue.json()).toMatchObject({ error: "payment-queue-unconfigured" });
    expect(queue.attempts).toEqual([]);
  });

  it("repeats byte-equivalent canonical messages", async () => {
    const queue = new RecordingQueue();
    const app = redriveApp(queue);
    const first = await redrive(app, { headers: auth });
    const second = await redrive(app, { headers: auth });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(queue.bodies).toHaveLength(4);
    expect(queue.bodies[0]).toBe(JSON.stringify(sampleDispatchRequest()));
    expect(queue.bodies[1]).toBe(JSON.stringify(sampleRefundRequest()));
    expect(queue.bodies[2]).toBe(queue.bodies[0]);
    expect(queue.bodies[3]).toBe(queue.bodies[1]);
  });

  it("ignores a forged body and emits only the durable settlement requests", async () => {
    const queue = new RecordingQueue();
    const forged = {
      settlementRecordId: "settlement:attacker",
      runId: "run:attacker",
      legs: [{ account: "seller", partyId: "seller:attacker", amountKobo: 1, memo: "forged" }],
      amountKobo: 999_999_999,
      recipient: "seller:attacker",
      idempotencyKey: "attacker-controlled-key",
    };
    const response = await redrive(redriveApp(queue), {
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(forged),
    });

    expect(response.status).toBe(202);
    expect(queue.bodies.map((body) => JSON.parse(body as string))).toEqual([
      sampleDispatchRequest(),
      sampleRefundRequest(),
    ]);
  });
});
