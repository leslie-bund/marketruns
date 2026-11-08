import { describe, expect, it } from "vitest";
import {
  PaymentRecoveryResponseSchema,
  type PaymentDispatchStatus,
  type PaymentHoldStatus,
  type PaymentRecoveryResponse,
  type PaymentRefundStatus,
} from "@market-runs/proto";
import { createPaymentsApp, type PaymentsAppOptions } from "../src/index.js";
import type { PaymentDispatcher } from "../src/dispatcher.js";
import { dispatchRow } from "../src/store.js";
import { expectedPaymentRequests, type SettlementAuthorization } from "../src/settlement.js";
import {
  InMemoryDispatchStore,
  InMemoryHoldStore,
  InMemoryRefundStore,
  InMemorySettlementStore,
  sampleHold,
  sampleSettlementAuthorization,
} from "./helpers.js";

const NOW = new Date("2027-01-15T12:00:00.000Z").getTime();
const RECENT = NOW - 14 * 60_000;
const STALE = NOW - 15 * 60_000 - 1;
const auth = { "x-payments-internal": "internal-test-token" };

const noProviderCalls: PaymentDispatcher = {
  async dispatchTransfer(): Promise<never> {
    throw new Error("recovery must not call a provider");
  },
};

function authorization(
  overrides: Omit<Partial<SettlementAuthorization>, "outcome"> & { outcome?: Partial<SettlementAuthorization["outcome"]> } = {},
): SettlementAuthorization {
  const base = sampleSettlementAuthorization();
  return {
    ...base,
    ...overrides,
    outcome: { ...base.outcome, buyerRefundKobo: 0, ...overrides.outcome },
  };
}

async function seedDispatches(
  store: InMemoryDispatchStore,
  settlement: SettlementAuthorization,
  statuses: PaymentDispatchStatus[],
  updatedAt = RECENT,
) {
  const expected = expectedPaymentRequests(settlement).dispatch;
  for (let index = 0; index < expected.legs.length; index += 1) {
    const row = dispatchRow(expected, index);
    await store.insertPending({
      ...row,
      status: statuses[index] ?? "completed",
      attempts: 1,
      createdAt: new Date(updatedAt),
      updatedAt: new Date(updatedAt),
    });
  }
}

async function seedRefund(
  refunds: InMemoryRefundStore,
  settlement: SettlementAuthorization,
  id: string,
  status: PaymentRefundStatus,
  updatedAt = RECENT,
) {
  await refunds.insertPending({
    id,
    holdId: `hold:${id}`,
    settlementRecordId: settlement.settlementRecordId,
    amountKobo: 1_000,
    status,
    providerRef: null,
    failureReason: null,
    attempts: 1,
    createdAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt),
    resolution: null,
  });
}

async function seedHold(
  holds: InMemoryHoldStore,
  settlement: SettlementAuthorization,
  id: string,
  status: PaymentHoldStatus,
  updatedAt = RECENT,
) {
  await holds.insertIfAbsent(sampleHold({
    id,
    txRef: id,
    runId: settlement.runId,
    buyerId: settlement.buyerId,
    status,
    createdAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt),
  }));
}

function recoveryApp(
  settlements: InMemorySettlementStore,
  store: InMemoryDispatchStore,
  holds = new InMemoryHoldStore(),
  refunds = new InMemoryRefundStore(),
  overrides: PaymentsAppOptions = {},
) {
  return createPaymentsApp(store, noProviderCalls, {
    settlements,
    collections: { holds, refunds, gateway: null },
    participantAuth: { internalToken: "internal-test-token" },
    now: () => new Date(NOW),
    ...overrides,
  });
}

async function getRecovery(
  app: ReturnType<typeof createPaymentsApp>,
  query = "",
): Promise<PaymentRecoveryResponse> {
  const response = await app.fetch(new Request(`http://payments/recovery${query}`, { headers: auth }));
  expect(response.status).toBe(200);
  return PaymentRecoveryResponseSchema.parse(await response.json());
}

describe("GET /recovery", () => {
  it("groups failed dispatch legs by settlement and omits healthy settlements", async () => {
    const stuck = authorization();
    const healthy = authorization({
      settlementRecordId: "settlement:healthy",
      runId: "run:healthy",
      market: "Yaba",
      buyerId: "buyer:2",
      runnerId: "runner:2",
    });
    const settlements = new InMemorySettlementStore([stuck, healthy]);
    const store = new InMemoryDispatchStore();
    await seedDispatches(store, stuck, ["failed", "failed", "completed"]);
    await seedDispatches(store, healthy, ["completed", "completed", "completed"]);

    const body = await getRecovery(recoveryApp(settlements, store));

    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      settlementRecordId: stuck.settlementRecordId,
      runId: stuck.runId,
      market: stuck.market,
      buyerId: stuck.buyerId,
      runnerId: stuck.runnerId,
    });
    expect(body.items[0]?.issues).toEqual([
      {
        kind: "dispatch",
        id: `${stuck.runId}:dispatch:0`,
        status: "failed",
        amountKobo: 148_500,
        updatedAt: RECENT,
      },
      {
        kind: "dispatch",
        id: `${stuck.runId}:dispatch:1`,
        status: "failed",
        amountKobo: 160_000,
        updatedAt: RECENT,
      },
    ]);
    expect(body.items[0]?.actions).toEqual([
      { type: "replay-dispatch", targetId: `${stuck.runId}:dispatch:0` },
      { type: "replay-dispatch", targetId: `${stuck.runId}:dispatch:1` },
    ]);
  });

  it("flags pending and stale in-flight dispatches with their targeted actions", async () => {
    const stuck = authorization();
    const recent = authorization({ settlementRecordId: "settlement:recent", runId: "run:recent" });
    const boundary = authorization({ settlementRecordId: "settlement:boundary", runId: "run:boundary" });
    const settlements = new InMemorySettlementStore([stuck, recent, boundary]);
    const store = new InMemoryDispatchStore();
    await seedDispatches(store, stuck, ["pending", "sent", "queued"], STALE);
    await seedDispatches(store, recent, ["sent", "queued", "completed"], RECENT);
    await seedDispatches(store, boundary, ["sent", "queued", "completed"], NOW - 15 * 60_000);

    const body = await getRecovery(recoveryApp(settlements, store));

    expect(body.total).toBe(1);
    expect(body.items[0]?.issues.map((issue) => [issue.kind, issue.id, issue.status])).toEqual([
      ["dispatch", `${stuck.runId}:dispatch:0`, "pending"],
      ["dispatch", `${stuck.runId}:dispatch:1`, "sent"],
      ["dispatch", `${stuck.runId}:dispatch:2`, "queued"],
    ]);
    expect(body.items[0]?.actions).toEqual([
      { type: "replay-dispatch", targetId: `${stuck.runId}:dispatch:0` },
      { type: "sync-dispatch", targetId: `${stuck.runId}:dispatch:1` },
      { type: "sync-dispatch", targetId: `${stuck.runId}:dispatch:2` },
    ]);
  });

  it("flags failed, review, and manual refunds plus stale held holds with deduped actions", async () => {
    const stuck = authorization({ settlementRecordId: "settlement:refunds", runId: "run:refunds" });
    const healthy = authorization({ settlementRecordId: "settlement:healthy-collection", runId: "run:healthy-collection" });
    const settlements = new InMemorySettlementStore([stuck, healthy]);
    const store = new InMemoryDispatchStore();
    const holds = new InMemoryHoldStore();
    const refunds = new InMemoryRefundStore();
    await seedDispatches(store, stuck, ["completed", "completed", "completed"]);
    await seedDispatches(store, healthy, ["completed", "completed", "completed"]);
    await seedRefund(refunds, stuck, "refund:failed", "failed");
    await seedRefund(refunds, stuck, "refund:review", "refund-review");
    await seedRefund(refunds, stuck, "refund:manual", "refund-manual");
    await seedHold(holds, stuck, "hold:stale", "held", STALE);
    await seedRefund(refunds, healthy, "refund:pending", "pending");
    await seedRefund(refunds, healthy, "refund:processing", "processing", STALE);
    await seedRefund(refunds, healthy, "refund:completed", "completed", STALE);
    await seedHold(holds, healthy, "hold:recent", "held", RECENT);
    await seedHold(holds, healthy, "hold:boundary", "held", NOW - 15 * 60_000);
    await seedHold(holds, healthy, "hold:released", "released", STALE);
    await seedHold(holds, healthy, "hold:failed", "failed", STALE);
    await seedHold(holds, healthy, "hold:refunded", "refunded", STALE);
    await seedHold(holds, healthy, "hold:partial", "partially-refunded", STALE);

    const body = await getRecovery(recoveryApp(settlements, store, holds, refunds));

    expect(body.total).toBe(1);
    expect(body.items[0]?.issues).toHaveLength(4);
    expect(body.items[0]?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "refund", id: "refund:failed", status: "failed", updatedAt: RECENT }),
      expect.objectContaining({ kind: "refund", id: "refund:review", status: "refund-review", updatedAt: RECENT }),
      expect.objectContaining({ kind: "refund", id: "refund:manual", status: "refund-manual", updatedAt: RECENT }),
      {
        kind: "hold",
        id: "hold:stale",
        status: "held",
        amountKobo: 335_000,
        updatedAt: STALE,
      },
    ]));
    expect(body.items[0]?.actions).toHaveLength(3);
    expect(body.items[0]?.actions).toEqual(expect.arrayContaining([
      { type: "redrive-settlement", targetId: stuck.settlementRecordId },
      { type: "resolve-refund", targetId: "refund:review" },
      { type: "resolve-refund", targetId: "refund:manual" },
    ]));
  });

  it("flags only stale pending refunds", async () => {
    const stale = authorization({ settlementRecordId: "settlement:pending-stale", runId: "run:pending-stale" });
    const recent = authorization({ settlementRecordId: "settlement:pending-recent", runId: "run:pending-recent" });
    const boundary = authorization({ settlementRecordId: "settlement:pending-boundary", runId: "run:pending-boundary" });
    const settlements = new InMemorySettlementStore([stale, recent, boundary]);
    const store = new InMemoryDispatchStore();
    const refunds = new InMemoryRefundStore();
    await seedDispatches(store, stale, ["completed", "completed", "completed"]);
    await seedDispatches(store, recent, ["completed", "completed", "completed"]);
    await seedDispatches(store, boundary, ["completed", "completed", "completed"]);
    await seedRefund(refunds, stale, "refund:stale", "pending", STALE);
    await seedRefund(refunds, recent, "refund:recent", "pending", RECENT);
    await seedRefund(refunds, boundary, "refund:boundary", "pending", NOW - 15 * 60_000);

    const body = await getRecovery(recoveryApp(settlements, store, new InMemoryHoldStore(), refunds));

    expect(body.total).toBe(1);
    expect(body.items[0]?.issues).toEqual([{
      kind: "refund",
      id: "refund:stale",
      status: "pending",
      amountKobo: 1_000,
      updatedAt: STALE,
    }]);
    expect(body.items[0]?.actions).toEqual([]);
  });

  it("detects canonical missing rows, excludes ungated refunds, and dedupes redrives", async () => {
    const missingDispatch = authorization({
      settlementRecordId: "run:missing-dispatch:settlement",
      runId: "run:missing-dispatch",
    });
    const missingRefund = authorization({
      settlementRecordId: "run:missing-refund:settlement",
      runId: "run:missing-refund",
      outcome: { buyerRefundKobo: 100_000 },
    });
    const noHold = authorization({
      settlementRecordId: "run:no-hold:settlement",
      runId: "run:no-hold",
      outcome: { buyerRefundKobo: 100_000 },
    });
    const complete = authorization({
      settlementRecordId: "run:complete-refund:settlement",
      runId: "run:complete-refund",
      outcome: { buyerRefundKobo: 100_000 },
    });
    const settlements = new InMemorySettlementStore([missingDispatch, missingRefund, noHold, complete]);
    const store = new InMemoryDispatchStore();
    const holds = new InMemoryHoldStore();
    const refunds = new InMemoryRefundStore();
    const existingRow = dispatchRow(expectedPaymentRequests(missingDispatch).dispatch, 1);
    await store.insertPending({
      ...existingRow,
      status: "completed",
      createdAt: new Date(RECENT),
      updatedAt: new Date(RECENT),
    });
    await seedDispatches(store, missingRefund, ["completed", "completed", "completed"]);
    await seedDispatches(store, noHold, ["completed", "completed", "completed"]);
    await seedDispatches(store, complete, ["completed", "completed", "completed"]);
    await seedHold(holds, missingRefund, "hold:missing-refund", "released");
    await seedHold(holds, complete, "hold:complete", "refunded");
    await seedRefund(refunds, complete, `refund:${complete.settlementRecordId}`, "completed");

    const body = await getRecovery(recoveryApp(settlements, store, holds, refunds));

    expect(body.items.find((item) => item.runId === complete.runId)).toBeUndefined();
    expect(body.total).toBe(2);
    const dispatchItem = body.items.find((item) => item.runId === missingDispatch.runId);
    expect(dispatchItem?.issues).toEqual([
      {
        kind: "missing",
        id: `${missingDispatch.runId}:dispatch:0`,
        status: "missing",
        amountKobo: null,
        updatedAt: NOW,
      },
      {
        kind: "missing",
        id: `${missingDispatch.runId}:dispatch:2`,
        status: "missing",
        amountKobo: null,
        updatedAt: NOW,
      },
    ]);
    expect(dispatchItem?.actions).toEqual([
      { type: "redrive-settlement", targetId: missingDispatch.settlementRecordId },
    ]);
    const refundItem = body.items.find((item) => item.runId === missingRefund.runId);
    expect(refundItem?.issues).toEqual([{
      kind: "missing",
      id: `refund:${missingRefund.settlementRecordId}`,
      status: "missing",
      amountKobo: null,
      updatedAt: NOW,
    }]);
    expect(refundItem?.actions).toEqual([
      { type: "redrive-settlement", targetId: missingRefund.settlementRecordId },
    ]);
  });

  it("filters attention items by market", async () => {
    const balogun = authorization({ market: "Balogun" });
    const yaba = authorization({
      settlementRecordId: "settlement:yaba",
      runId: "run:yaba",
      market: "Yaba",
    });
    const settlements = new InMemorySettlementStore([balogun, yaba]);
    const store = new InMemoryDispatchStore();
    await seedDispatches(store, balogun, ["failed", "completed", "completed"]);
    await seedDispatches(store, yaba, ["failed", "completed", "completed"]);
    const app = recoveryApp(settlements, store);

    const filtered = await getRecovery(app, "?market=Yaba");
    const all = await getRecovery(app);

    expect(filtered.total).toBe(1);
    expect(filtered.items.map((item) => item.market)).toEqual(["Yaba"]);
    expect(all.total).toBe(2);
    expect(new Set(all.items.map((item) => item.runId))).toEqual(new Set([balogun.runId, yaba.runId]));
  });

  it("requires valid internal service authentication", async () => {
    const app = recoveryApp(new InMemorySettlementStore([]), new InMemoryDispatchStore());

    const missing = await app.fetch(new Request("http://payments/recovery"));
    const forged = await app.fetch(new Request("http://payments/recovery", {
      headers: { "x-payments-internal": "forged-token" },
    }));

    expect(missing.status).toBe(401);
    expect(forged.status).toBe(401);
  });

  it("performs no payment writes, provider calls, queue sends, or notifications", async () => {
    const stuck = authorization();
    const settlements = new InMemorySettlementStore([stuck]);
    const store = new InMemoryDispatchStore();
    const holds = new InMemoryHoldStore();
    const refunds = new InMemoryRefundStore();
    await seedDispatches(store, stuck, ["failed", "completed", "completed"]);
    await seedHold(holds, stuck, "hold:stale", "held", STALE);
    await seedRefund(refunds, stuck, "refund:failed", "failed");
    const before = structuredClone({
      dispatches: store.rows,
      holds: holds.rows,
      refunds: refunds.rows,
    });
    let queueSends = 0;
    let notifications = 0;
    const app = recoveryApp(settlements, store, holds, refunds, {
      paymentQueue: {
        async send(): Promise<QueueSendResponse> {
          queueSends += 1;
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        },
      },
      notify: async () => {
        notifications += 1;
      },
    });

    const body = await getRecovery(app);

    expect(body.total).toBe(1);
    expect({ dispatches: store.rows, holds: holds.rows, refunds: refunds.rows }).toEqual(before);
    expect(queueSends).toBe(0);
    expect(notifications).toBe(0);
  });

  it("detects only the absent refund row in a multi-hold settlement", async () => {
    const stuck = authorization({
      settlementRecordId: "run:multi-hold:settlement",
      runId: "run:multi-hold",
      outcome: { buyerRefundKobo: 100_000 },
    });
    const settlements = new InMemorySettlementStore([stuck]);
    const store = new InMemoryDispatchStore();
    const holds = new InMemoryHoldStore();
    const refunds = new InMemoryRefundStore();
    await seedDispatches(store, stuck, ["completed", "completed", "completed"]);
    await holds.insertIfAbsent(sampleHold({
      id: "hold:first",
      txRef: "hold:first",
      runId: stuck.runId,
      amountKobo: 60_000,
      status: "released",
      updatedAt: new Date(RECENT),
    }));
    await holds.insertIfAbsent(sampleHold({
      id: "hold:second",
      txRef: "hold:second",
      runId: stuck.runId,
      amountKobo: 40_000,
      status: "released",
      updatedAt: new Date(RECENT),
    }));
    await seedRefund(refunds, stuck, `refund:${stuck.settlementRecordId}:hold:first`, "completed");

    const body = await getRecovery(recoveryApp(settlements, store, holds, refunds));

    expect(body.total).toBe(1);
    expect(body.items[0]?.issues).toEqual([{
      kind: "missing",
      id: `refund:${stuck.settlementRecordId}:hold:second`,
      status: "missing",
      amountKobo: null,
      updatedAt: NOW,
    }]);
    expect(body.items[0]?.actions).toEqual([
      { type: "redrive-settlement", targetId: stuck.settlementRecordId },
    ]);
  });
});
