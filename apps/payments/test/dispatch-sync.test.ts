import { describe, expect, it } from "vitest";
import type { NotificationTransition, PaymentDispatchStatus } from "@market-runs/proto";
import { createPaymentsApp } from "../src/index.js";
import type { DispatchTransferResult, PaymentDispatcher, TransferStatusLookup } from "../src/dispatcher.js";
import { dispatchRow, type DispatchRow } from "../src/store.js";
import { InMemoryDispatchStore, sampleDispatchRequest } from "./helpers.js";

class RecordingLookupDispatcher implements PaymentDispatcher, TransferStatusLookup {
  dispatchCalls = 0;
  readonly lookupRefs: string[] = [];

  constructor(private readonly byRef: Record<string, DispatchTransferResult | null>) {}

  async dispatchTransfer(): Promise<DispatchTransferResult> {
    this.dispatchCalls += 1;
    return { status: "queued", providerRef: "flw:unexpected-replay" };
  }

  async fetchTransferStatus(providerRef: string): Promise<DispatchTransferResult | null> {
    this.lookupRefs.push(providerRef);
    return this.byRef[providerRef] ?? null;
  }
}

class UnsupportedDispatcher implements PaymentDispatcher {
  dispatchCalls = 0;

  async dispatchTransfer(): Promise<DispatchTransferResult> {
    this.dispatchCalls += 1;
    return { status: "queued" };
  }
}

async function seedDispatch(
  store: InMemoryDispatchStore,
  status: PaymentDispatchStatus = "sent",
  providerRef: string | null = "flw:single-sync",
): Promise<DispatchRow> {
  const row = dispatchRow(sampleDispatchRequest(), 0);
  await store.insertPending(status === "pending" ? { ...row, providerRef } : row);
  if (status !== "pending") {
    await store.recordResult(row.id, { status, ...(providerRef === null ? {} : { providerRef }) });
  }
  return (await store.byId(row.id))!;
}

function syncRequest(id: string, internalToken?: string): Request {
  return new Request(`http://payments/dispatches/${encodeURIComponent(id)}/sync`, {
    method: "POST",
    ...(internalToken === undefined ? {} : { headers: { "x-payments-internal": internalToken } }),
  });
}

describe("POST /dispatches/:id/sync", () => {
  it("applies a completed provider status without replaying or incrementing attempts", async () => {
    const store = new InMemoryDispatchStore();
    const row = await seedDispatch(store);
    const dispatcher = new RecordingLookupDispatcher({
      "flw:single-sync": { status: "completed", providerRef: "flw:single-sync" },
    });
    const notifications: NotificationTransition[] = [];
    const app = createPaymentsApp(store, dispatcher, {
      notify: async (notification) => { notifications.push(notification); },
    });

    const response = await app.fetch(syncRequest(row.id));

    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("applied");
    const updated = (await store.byId(row.id))!;
    expect(updated.status).toBe("completed");
    expect(updated.attempts).toBe(row.attempts);
    expect(dispatcher.lookupRefs).toEqual(["flw:single-sync"]);
    expect(dispatcher.dispatchCalls).toBe(0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      sourceEventId: `payment.dispatch-status:${row.id}:completed`,
      sourceEventType: "payment.dispatch-updated",
      recipientId: row.partyId,
      title: "Dispatch completed",
      body: `Your ${row.account} dispatch is completed.`,
      deepLink: "/notifications",
      data: { status: "completed", runId: row.runId },
    });
  });

  it("applies a failed provider status and sends the bulk-compatible notification", async () => {
    const store = new InMemoryDispatchStore();
    const row = await seedDispatch(store, "queued");
    const dispatcher = new RecordingLookupDispatcher({
      "flw:single-sync": { status: "failed", providerRef: "flw:single-sync", failureReason: "bank rejected" },
    });
    const notifications: NotificationTransition[] = [];
    const app = createPaymentsApp(store, dispatcher, {
      notify: async (notification) => { notifications.push(notification); },
    });

    const response = await app.fetch(syncRequest(row.id));

    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("applied");
    const updated = (await store.byId(row.id))!;
    expect(updated.status).toBe("failed");
    expect(updated.failureReason).toBe("bank rejected");
    expect(updated.failureRetryable).toBe(false);
    expect(updated.attempts).toBe(row.attempts);
    expect(dispatcher.dispatchCalls).toBe(0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      sourceEventId: `payment.dispatch-status:${row.id}:failed`,
      sourceEventType: "payment.dispatch-updated",
      recipientId: row.partyId,
      title: "Dispatch failed",
      body: `Your ${row.account} dispatch is failed.`,
      deepLink: "/notifications",
      data: { status: "failed", runId: row.runId },
    });
  });

  it("returns unchanged without mutation for a nonterminal provider status", async () => {
    const store = new InMemoryDispatchStore();
    const row = await seedDispatch(store);
    const dispatcher = new RecordingLookupDispatcher({
      "flw:single-sync": { status: "sent", providerRef: "flw:single-sync" },
    });
    const app = createPaymentsApp(store, dispatcher);

    const response = await app.fetch(syncRequest(row.id));

    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("unchanged");
    expect(await store.byId(row.id)).toEqual(row);
    expect(dispatcher.dispatchCalls).toBe(0);
  });

  it("returns unmatched without mutation when the provider has no status", async () => {
    const store = new InMemoryDispatchStore();
    const row = await seedDispatch(store);
    const dispatcher = new RecordingLookupDispatcher({ "flw:single-sync": null });
    const app = createPaymentsApp(store, dispatcher);

    const response = await app.fetch(syncRequest(row.id));

    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("unmatched");
    expect(await store.byId(row.id)).toEqual(row);
    expect(dispatcher.dispatchCalls).toBe(0);
  });

  it("returns 409 unmatched without polling when providerRef is missing", async () => {
    const store = new InMemoryDispatchStore();
    const row = await seedDispatch(store, "sent", null);
    const dispatcher = new RecordingLookupDispatcher({});
    const app = createPaymentsApp(store, dispatcher);

    const response = await app.fetch(syncRequest(row.id));

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe("unmatched");
    expect(await store.byId(row.id)).toEqual(row);
    expect(dispatcher.lookupRefs).toEqual([]);
    expect(dispatcher.dispatchCalls).toBe(0);
  });

  it.each(["pending", "completed", "failed"] as const)("rejects a %s dispatch as not-stale", async (status) => {
    const store = new InMemoryDispatchStore();
    const row = await seedDispatch(store, status);
    const dispatcher = new RecordingLookupDispatcher({});
    const app = createPaymentsApp(store, dispatcher);

    const response = await app.fetch(syncRequest(row.id));

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe("not-stale");
    expect(await store.byId(row.id)).toEqual(row);
    expect(dispatcher.lookupRefs).toEqual([]);
    expect(dispatcher.dispatchCalls).toBe(0);
  });

  it("returns 404 for an unknown dispatch", async () => {
    const store = new InMemoryDispatchStore();
    const dispatcher = new RecordingLookupDispatcher({});
    const app = createPaymentsApp(store, dispatcher);

    const response = await app.fetch(syncRequest("unknown-dispatch"));

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("not-found");
    expect(dispatcher.lookupRefs).toEqual([]);
    expect(dispatcher.dispatchCalls).toBe(0);
  });

  it("returns 501 sync-unsupported without replaying", async () => {
    const store = new InMemoryDispatchStore();
    const row = await seedDispatch(store);
    const dispatcher = new UnsupportedDispatcher();
    const app = createPaymentsApp(store, dispatcher);

    const response = await app.fetch(syncRequest(row.id));

    expect(response.status).toBe(501);
    expect(((await response.json()) as { error: string }).error).toBe("sync-unsupported");
    expect(await store.byId(row.id)).toEqual(row);
    expect(dispatcher.dispatchCalls).toBe(0);
  });

  it("requires internal authentication and never polls on rejected requests", async () => {
    const store = new InMemoryDispatchStore();
    const row = await seedDispatch(store);
    const dispatcher = new RecordingLookupDispatcher({
      "flw:single-sync": { status: "completed", providerRef: "flw:single-sync" },
    });
    const app = createPaymentsApp(store, dispatcher, {
      participantAuth: { internalToken: "internal-test-token" },
    });

    const missing = await app.fetch(syncRequest(row.id));
    const forged = await app.fetch(syncRequest(row.id, "forged-token"));

    expect(missing.status).toBe(401);
    expect(forged.status).toBe(401);
    expect(await store.byId(row.id)).toEqual(row);
    expect(dispatcher.lookupRefs).toEqual([]);
    expect(dispatcher.dispatchCalls).toBe(0);

    const authenticated = await app.fetch(syncRequest(row.id, "internal-test-token"));
    expect(authenticated.status).toBe(200);
    expect((await store.byId(row.id))!.status).toBe("completed");
    expect(dispatcher.dispatchCalls).toBe(0);
  });
});
