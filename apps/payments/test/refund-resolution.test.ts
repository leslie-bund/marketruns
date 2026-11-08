import { describe, expect, it } from "vitest";
import type { PaymentRefundResolutionRequest, PaymentRefundStatus } from "@market-runs/proto";
import { createPaymentsApp } from "../src/index.js";
import { StubDispatcher } from "../src/dispatcher.js";
import type {
  ChargeGateway,
  ChargeRefundReconciliationResult,
  ChargeRefundResult,
  ChargeVerification,
} from "../src/gateway.js";
import { expectedPaymentRequests } from "../src/settlement.js";
import type { RefundRow } from "../src/refunds.js";
import {
  InMemoryDispatchStore,
  InMemoryHoldStore,
  InMemoryRefundStore,
  InMemorySettlementStore,
  sampleHold,
  sampleRefundRequest,
  sampleSettlementAuthorization,
} from "./helpers.js";

const refundRequest = sampleRefundRequest();
const refundId = `refund:${refundRequest.settlementRecordId}`;

const acceptResolution = {
  action: "accept-provider",
  status: "processing",
  providerRef: "provider-refund-1",
  evidenceRef: "evidence/refund-1.json",
  note: "One accepted provider refund was verified.",
} as const;

const retryResolution = {
  action: "allow-retry",
  evidenceRef: "evidence/retry-1.json",
  note: "Provider proved that no refund was accepted.",
} as const;

class NoProviderGateway implements ChargeGateway {
  refundCalls = 0;
  reconcileCalls = 0;
  async verifyCharge(): Promise<ChargeVerification | null> {
    return null;
  }
  async refundCharge(): Promise<ChargeRefundResult> {
    this.refundCalls += 1;
    throw new Error("resolution must not execute a provider refund");
  }
  async reconcileRefund(): Promise<ChargeRefundReconciliationResult> {
    this.reconcileCalls += 1;
    throw new Error("resolution must not query the provider");
  }
  supportsRefund(): boolean {
    return true;
  }
  async listBanks() {
    return [];
  }
  async resolveAccount() {
    return null;
  }
}

async function seed(
  status: PaymentRefundStatus,
  overrides: Partial<RefundRow> = {},
): Promise<{ holds: InMemoryHoldStore; refunds: InMemoryRefundStore; row: RefundRow }> {
  const holds = new InMemoryHoldStore();
  await holds.insertIfAbsent(sampleHold());
  const refunds = new InMemoryRefundStore();
  const row: RefundRow = {
    id: refundId,
    holdId: sampleHold().id,
    settlementRecordId: refundRequest.settlementRecordId,
    amountKobo: refundRequest.amountKobo,
    status,
    providerRef: null,
    failureReason: status === "refund-review"
      ? "reconciliation-conflict: multiple accepted refunds"
      : status === "refund-manual"
        ? "no API refund rail"
        : "provider-unreachable: timeout",
    attempts: 2,
    resolution: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
  await refunds.insertPending(row);
  return { holds, refunds, row: (await refunds.byId(refundId))! };
}

function workerWith({
  holds,
  refunds,
  gateway = new NoProviderGateway(),
  queue,
  settlements = new InMemorySettlementStore(),
  withSettlements = true,
}: {
  holds: InMemoryHoldStore;
  refunds: InMemoryRefundStore;
  gateway?: ChargeGateway;
  queue?: { send(body: unknown): Promise<unknown> };
  settlements?: InMemorySettlementStore;
  withSettlements?: boolean;
}) {
  return createPaymentsApp(new InMemoryDispatchStore(), new StubDispatcher(), {
    collections: { holds, refunds, gateway },
    ...(withSettlements ? { settlements } : {}),
    ...(queue ? { paymentQueue: queue as unknown as Pick<Queue, "send"> } : {}),
  });
}

function resolveRequest(
  body: unknown,
  id = refundId,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://payments/payments/refunds/${encodeURIComponent(id)}/resolution`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function body(resolution: unknown, resolvedBy = "ops:ada"): PaymentRefundResolutionRequest {
  return { resolvedBy, resolution } as PaymentRefundResolutionRequest;
}

describe("audited refund resolution", () => {
  it.each([
    ["processing", 100_000, "partially-refunded"],
    ["completed", 335_000, "refunded"],
  ] as const)("accept-provider %s records evidence and existing committed hold accounting", async (
    providerStatus,
    amountKobo,
    holdStatus,
  ) => {
    const { holds, refunds } = await seed("refund-review", { amountKobo });
    const gateway = new NoProviderGateway();
    const worker = workerWith({ holds, refunds, gateway });

    const response = await worker.fetch(resolveRequest(body({
      ...acceptResolution,
      status: providerStatus,
      providerRef: "  provider-refund-1  ",
      evidenceRef: "  evidence/refund-1.json  ",
      note: "  Verified provider evidence.  ",
    }, "  ops:ada  ")));

    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.outcome).toBe("applied");
    expect(result.retryEnqueued).toBe(false);
    expect(result.refund).toMatchObject({
      id: refundId,
      status: providerStatus,
      providerRef: "provider-refund-1",
      failureReason: null,
      attempts: 2,
      resolution: {
        action: "accept-provider",
        status: providerStatus,
        providerRef: "provider-refund-1",
        evidenceRef: "evidence/refund-1.json",
        note: "Verified provider evidence.",
        resolvedBy: "ops:ada",
      },
    });
    expect(result.refund.resolution.resolvedAt).toEqual(expect.any(Number));
    expect((await holds.byId(sampleHold().id))?.status).toBe(holdStatus);
    expect(gateway.refundCalls).toBe(0);
    expect(gateway.reconcileCalls).toBe(0);
  });

  it("complete-manual records terminal evidence and updates the hold without an attempt", async () => {
    const { holds, refunds } = await seed("refund-manual");
    const worker = workerWith({ holds, refunds });

    const response = await worker.fetch(resolveRequest(body({
      action: "complete-manual",
      providerRef: "manual-transfer-9",
      evidenceRef: "evidence/manual-9.json",
      note: "Bank receipt checked by operations.",
    })));

    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.refund).toMatchObject({
      status: "completed",
      providerRef: "manual-transfer-9",
      failureReason: null,
      attempts: 2,
      resolution: {
        action: "complete-manual",
        status: "completed",
        providerRef: "manual-transfer-9",
        evidenceRef: "evidence/manual-9.json",
        note: "Bank receipt checked by operations.",
        resolvedBy: "ops:ada",
      },
    });
    expect((await holds.byId(sampleHold().id))?.status).toBe("partially-refunded");
  });

  it("allow-retry commits the audit first and enqueues only the exact canonical refund", async () => {
    const { holds, refunds } = await seed("refund-review");
    const gateway = new NoProviderGateway();
    const sent: unknown[] = [];
    const worker = workerWith({
      holds,
      refunds,
      gateway,
      queue: { send: async (value) => { sent.push(value); } },
    });

    const response = await worker.fetch(resolveRequest(body(retryResolution)));

    expect(response.status).toBe(202);
    const result = await response.json() as any;
    expect(result).toMatchObject({ outcome: "applied", retryEnqueued: true });
    expect(result.refund).toMatchObject({
      status: "failed",
      failureReason: "reconciliation-conflict: multiple accepted refunds",
      providerRef: null,
      attempts: 2,
      resolution: { ...retryResolution, status: "failed", providerRef: null, resolvedBy: "ops:ada" },
    });
    expect(sent).toEqual([JSON.stringify(expectedPaymentRequests(sampleSettlementAuthorization()).refund)]);
    expect((await holds.byId(sampleHold().id))?.status).toBe("held");
    expect(gateway.refundCalls).toBe(0);
    expect(gateway.reconcileCalls).toBe(0);
  });

  it("identical accept replay preserves the original evidence, timestamps, and hold", async () => {
    const { holds, refunds } = await seed("refund-review");
    const worker = workerWith({ holds, refunds });
    const request = resolveRequest(body(acceptResolution));
    const first = await worker.fetch(request);
    const applied = await first.json() as any;
    const holdAfterApply = await holds.byId(sampleHold().id);

    await new Promise((resolve) => setTimeout(resolve, 3));
    const second = await worker.fetch(resolveRequest(body(acceptResolution)));
    const replayed = await second.json() as any;

    expect(second.status).toBe(200);
    expect(replayed.outcome).toBe("replayed");
    expect(replayed.retryEnqueued).toBe(false);
    expect(replayed.refund).toEqual(applied.refund);
    expect(await refunds.byId(refundId)).toMatchObject({ updatedAt: new Date(applied.refund.updatedAt) });
    expect(await holds.byId(sampleHold().id)).toEqual(holdAfterApply);
  });

  it("identical allow-retry replay does not enqueue a duplicate and still replays after advancement", async () => {
    const { holds, refunds } = await seed("refund-review");
    const sent: unknown[] = [];
    const worker = workerWith({ holds, refunds, queue: { send: async (value) => { sent.push(value); } } });
    const first = await worker.fetch(resolveRequest(body(retryResolution)));
    const applied = await first.json() as any;

    const second = await worker.fetch(resolveRequest(body(retryResolution)));
    const replayed = await second.json() as any;

    expect(second.status).toBe(202);
    expect(replayed).toMatchObject({ outcome: "replayed", retryEnqueued: false, refund: applied.refund });
    expect(sent).toHaveLength(1);
    expect((await refunds.byId(refundId))?.resolution?.resolvedAt).toEqual(new Date(applied.refund.resolution.resolvedAt));
  });

  it("a different fingerprint conflicts before the post-resolution state check", async () => {
    const { holds, refunds } = await seed("refund-review");
    const sent: unknown[] = [];
    const worker = workerWith({ holds, refunds, queue: { send: async (value) => { sent.push(value); } } });
    await worker.fetch(resolveRequest(body(retryResolution)));
    const before = await refunds.byId(refundId);

    const response = await worker.fetch(resolveRequest(body({ ...retryResolution, evidenceRef: "evidence/other.json" })));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "resolution-conflict" });
    expect(await refunds.byId(refundId)).toEqual(before);
    expect(sent).toHaveLength(1);
  });

  it.each([
    ["refund-manual", acceptResolution],
    ["failed", acceptResolution],
    ["refund-review", { action: "complete-manual", providerRef: "manual-1", evidenceRef: "e/1", note: "done" }],
    ["failed", retryResolution],
  ] as const)("rejects an invalid resolution state %s without writing an audit row", async (status, resolution) => {
    const { holds, refunds } = await seed(status);
    const before = await refunds.byId(refundId);
    const worker = workerWith({ holds, refunds, queue: { send: async () => ({}) } });

    const response = await worker.fetch(resolveRequest(body(resolution)));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "invalid-state" });
    expect(await refunds.byId(refundId)).toEqual(before);
  });

  it.each([
    "amountKobo",
    "legs",
    "runId",
    "idempotencyKey",
    "resolvedBy",
    "resolvedAt",
  ])("rejects spoofed resolution field %s over HTTP without mutation", async (field) => {
    const { holds, refunds } = await seed("refund-review");
    const before = await refunds.byId(refundId);
    const worker = workerWith({ holds, refunds });

    const response = await worker.fetch(resolveRequest({
      resolvedBy: "ops:ada",
      resolution: { ...acceptResolution, [field]: "spoofed" },
    }));

    expect(response.status).toBe(400);
    expect(await refunds.byId(refundId)).toEqual(before);
  });

  it("returns not-found for an unknown refund", async () => {
    const { holds, refunds } = await seed("refund-review");
    const worker = workerWith({ holds, refunds });
    const response = await worker.fetch(resolveRequest(body(acceptResolution), "refund:unknown"));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not-found" });
  });

  it("queue failure returns 502 with the committed failed refund and does not roll back", async () => {
    const { holds, refunds } = await seed("refund-review");
    const worker = workerWith({
      holds,
      refunds,
      queue: { send: async () => { throw new Error("queue unavailable"); } },
    });

    const response = await worker.fetch(resolveRequest(body(retryResolution)));

    expect(response.status).toBe(502);
    const result = await response.json() as any;
    expect(result).toMatchObject({
      error: "refund-retry-enqueue-failed",
      outcome: "applied",
      resolutionCommitted: true,
      retryEnqueued: false,
      refund: { id: refundId, status: "failed", resolution: retryResolution },
    });
    expect((await refunds.byId(refundId))?.status).toBe("failed");
    expect((await holds.byId(sampleHold().id))?.status).toBe("held");
  });

  it.each(["settlements", "queue"] as const)("allow-retry requires %s before commitment", async (missing) => {
    const { holds, refunds } = await seed("refund-review");
    const before = await refunds.byId(refundId);
    const worker = workerWith({
      holds,
      refunds,
      withSettlements: missing !== "settlements",
      ...(missing === "queue" ? {} : { queue: { send: async () => ({}) } }),
    });

    const response = await worker.fetch(resolveRequest(body(retryResolution)));

    expect(response.status).toBe(503);
    expect(await refunds.byId(refundId)).toEqual(before);
  });

  it("allow-retry requires a canonical refund before commitment", async () => {
    const { holds, refunds } = await seed("refund-review");
    const authorization = sampleSettlementAuthorization();
    authorization.outcome.buyerRefundKobo = 0;
    const before = await refunds.byId(refundId);
    const worker = workerWith({
      holds,
      refunds,
      settlements: new InMemorySettlementStore([authorization]),
      queue: { send: async () => ({}) },
    });

    const response = await worker.fetch(resolveRequest(body(retryResolution)));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "canonical-refund-missing" });
    expect(await refunds.byId(refundId)).toEqual(before);
  });

  it("lists both nested resolutions and null for unresolved refunds", async () => {
    const { holds, refunds } = await seed("refund-review");
    await refunds.insertPending({
      ...(await refunds.byId(refundId))!,
      id: "refund:unresolved",
      settlementRecordId: "settlement:unresolved",
      status: "failed",
      resolution: null,
    });
    const worker = workerWith({ holds, refunds });
    await worker.fetch(resolveRequest(body(acceptResolution)));

    const response = await worker.fetch(new Request("http://payments/payments/refunds"));
    const listed = await response.json() as any;

    expect(response.status).toBe(200);
    expect(listed.items.find((item: any) => item.id === refundId).resolution).toMatchObject(acceptResolution);
    expect(listed.items.find((item: any) => item.id === "refund:unresolved").resolution).toBeNull();
  });
});
