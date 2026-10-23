import { describe, expect, it } from "vitest";
import { createPaymentsApp, type PaymentsAppOptions } from "../src/index.js";
import type { DispatchTransferResult, PaymentDispatcher, TransferStatusLookup } from "../src/dispatcher.js";
import { StubDispatcher } from "../src/dispatcher.js";
import { WEBHOOK_HASH_HEADER, parseTransferWebhook, verifyWebhookHash } from "../src/flutterwave/webhook.js";
import { dispatchRow, type DispatchRow } from "../src/store.js";
import { handleDispatchRequested } from "../src/consume.js";
import { FakeMessage, InMemoryDispatchStore, sampleDispatchRequest } from "./helpers.js";

/**
 * Status tracking: provider webhooks (hash-verified) and the polling sync
 * converge in-flight rows (queued/sent) to terminal states
 * (completed/failed). In-memory store; dispatcher doubles — no network.
 */

const WEBHOOK_HASH = "test-webhook-hash";

/** Webhook option wiring, exactly as the resolved vendor integration supplies it. */
const WEBHOOK_OPTIONS: PaymentsAppOptions = {
  webhook: {
    secret: WEBHOOK_HASH,
    hooks: { hashHeader: WEBHOOK_HASH_HEADER, verify: verifyWebhookHash, parse: parseTransferWebhook },
  },
};

function webhookRequest(body: unknown, hash: string | null = WEBHOOK_HASH): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (hash !== null) headers["verif-hash"] = hash;
  return new Request("http://payments/webhooks/transfers", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** Seed one row per leg; the first leg is left queued with a flw: providerRef. */
async function seededInFlight(store: InMemoryDispatchStore): Promise<DispatchRow[]> {
  const request = sampleDispatchRequest();
  const rows: DispatchRow[] = [];
  for (let index = 0; index < request.legs.length; index += 1) {
    const row = dispatchRow(request, index);
    await store.insertPending(row);
    await store.recordResult(row.id, { status: "queued", providerRef: `flw:${100 + index}` });
    rows.push((await store.byId(row.id))!);
  }
  return rows;
}

describe("POST /webhooks/transfers", () => {
  it("happy path: SUCCESSFUL webhook completes the matching row without touching attempts", async () => {
    const store = new InMemoryDispatchStore();
    const [row] = await seededInFlight(store);
    const app = createPaymentsApp(store, new StubDispatcher(), WEBHOOK_OPTIONS);

    const response = await app.fetch(
      webhookRequest({
        event: "transfer.completed",
        "event.type": "Transfer",
        data: { id: 100, reference: row!.idempotencyKey, status: "SUCCESSFUL", complete_message: "Transaction was successful" },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; dispatch: { status: string; attempts: number } };
    expect(body.status).toBe("applied");
    expect(body.dispatch.status).toBe("completed");
    expect(body.dispatch.attempts).toBe(1); // webhook is not a re-execution
  });

  it("rejects a bad (or missing) hash with 401 and touches nothing", async () => {
    const store = new InMemoryDispatchStore();
    const [row] = await seededInFlight(store);
    const app = createPaymentsApp(store, new StubDispatcher(), WEBHOOK_OPTIONS);

    for (const request of [webhookRequest({ event: "transfer.completed", data: { reference: row!.idempotencyKey, status: "SUCCESSFUL" } }, "wrong-hash"), webhookRequest({ event: "transfer.completed", data: { reference: row!.idempotencyKey, status: "SUCCESSFUL" } }, null)]) {
      const response = await app.fetch(request);
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: string }).error).toBe("invalid-webhook-hash");
    }
    expect((await store.byId(row!.id))!.status).toBe("queued");
  });

  it("503s when no webhook secret hash is configured", async () => {
    const store = new InMemoryDispatchStore();
    const app = createPaymentsApp(store, new StubDispatcher());
    const response = await app.fetch(webhookRequest({ event: "transfer.completed", data: {} }));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe("webhook-not-configured");
  });

  it("FAILED webhook marks the row failed with the provider's message", async () => {
    const store = new InMemoryDispatchStore();
    const [row] = await seededInFlight(store);
    const app = createPaymentsApp(store, new StubDispatcher(), WEBHOOK_OPTIONS);

    const response = await app.fetch(
      webhookRequest({
        event: "transfer.completed",
        "event.type": "Transfer",
        data: { id: 100, reference: row!.idempotencyKey, status: "FAILED", complete_message: "DISBURSE FAILED: Insufficient funds" },
      }),
    );
    expect(response.status).toBe(200);
    const updated = (await store.byId(row!.id))!;
    expect(updated.status).toBe("failed");
    expect(updated.failureReason).toBe("DISBURSE FAILED: Insufficient funds");
    expect(updated.failureRetryable).toBe(false);
  });

  it("matches by providerRef when the webhook carries no reference", async () => {
    const store = new InMemoryDispatchStore();
    const rows = await seededInFlight(store);
    const app = createPaymentsApp(store, new StubDispatcher(), WEBHOOK_OPTIONS);

    const response = await app.fetch(
      webhookRequest({ type: "transfer.disburse", data: { id: "101", status: "SUCCESSFUL" } }),
    );
    expect(response.status).toBe(200);
    expect((await store.byId(rows[1]!.id))!.status).toBe("completed");
  });

  it("acknowledges unmatched references and ignores non-transfer events", async () => {
    const store = new InMemoryDispatchStore();
    const app = createPaymentsApp(store, new StubDispatcher(), WEBHOOK_OPTIONS);

    const unmatched = await app.fetch(
      webhookRequest({ event: "transfer.completed", data: { id: 555, reference: "settlement:nope:leg:0", status: "SUCCESSFUL" } }),
    );
    expect(unmatched.status).toBe(200);
    expect(((await unmatched.json()) as { status: string }).status).toBe("unmatched");

    const ignored = await app.fetch(webhookRequest({ event: "charge.completed", data: { id: 1 } }));
    expect(ignored.status).toBe(200);
    expect(((await ignored.json()) as { status: string }).status).toBe("ignored");
  });

  it("400s malformed transfer payloads (after hash verification)", async () => {
    const store = new InMemoryDispatchStore();
    const app = createPaymentsApp(store, new StubDispatcher(), WEBHOOK_OPTIONS);
    const response = await app.fetch(webhookRequest({ event: "transfer.completed" }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid-webhook-payload");
  });
});

/** Dispatcher double with a scripted status-lookup table. */
class LookupDispatcher implements PaymentDispatcher, TransferStatusLookup {
  constructor(private readonly byRef: Record<string, DispatchTransferResult | null>) {}
  async dispatchTransfer(): Promise<DispatchTransferResult> {
    throw new Error("not used");
  }
  async fetchTransferStatus(providerRef: string): Promise<DispatchTransferResult | null> {
    return this.byRef[providerRef] ?? null;
  }
}

describe("POST /dispatches/sync", () => {
  it("501s when the dispatcher cannot poll (stub)", async () => {
    const app = createPaymentsApp(new InMemoryDispatchStore(), new StubDispatcher());
    const response = await app.fetch(new Request("http://payments/dispatches/sync", { method: "POST" }));
    expect(response.status).toBe(501);
    expect(((await response.json()) as { error: string }).error).toBe("sync-unsupported");
  });

  it("converges stale in-flight rows: completed, failed, unchanged, unmatched", async () => {
    const store = new InMemoryDispatchStore();
    const request = sampleDispatchRequest();
    // leg 0: stale queued, provider says SUCCESSFUL → completed
    // leg 1: stale sent, provider says FAILED → failed
    // leg 2: stale queued, provider still NEW → unchanged
    const statuses = ["queued", "sent", "queued"] as const;
    for (let index = 0; index < request.legs.length; index += 1) {
      const row = dispatchRow(request, index);
      await store.insertPending(row);
      await store.recordResult(row.id, { status: statuses[index]!, providerRef: `flw:${200 + index}` });
    }
    // A fresh in-flight row (not stale) must be left alone.
    const fresh = dispatchRow(request, 0);
    await store.insertPending({ ...fresh, id: "fresh:dispatch", idempotencyKey: "settlement:fresh:leg:0" });
    await store.recordResult("fresh:dispatch", { status: "queued", providerRef: "flw:299" });
    // A stale queued row with no providerRef cannot be polled.
    await store.insertPending({ ...fresh, id: "norefd:dispatch", idempotencyKey: "settlement:noref:leg:0" });
    await store.recordResult("norefd:dispatch", { status: "queued" });

    const staleCutoff = new Date(Date.now() - 60 * 60_000);
    for (const row of [...store.rows.values()]) {
      if (row.id === "fresh:dispatch") continue;
      row.updatedAt = staleCutoff;
    }

    const dispatcher = new LookupDispatcher({
      "flw:200": { status: "completed", providerRef: "flw:200" },
      "flw:201": { status: "failed", providerRef: "flw:201", failureReason: "Account resolve failed" },
      "flw:202": { status: "queued", providerRef: "flw:202" },
    });
    const app = createPaymentsApp(store, dispatcher);

    const response = await app.fetch(
      new Request("http://payments/dispatches/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ staleMinutes: 30 }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { scanned: number; updated: number; unchanged: number; unmatched: number };
    expect(body).toEqual({ scanned: 4, updated: 2, unchanged: 1, unmatched: 1, staleMinutes: 30 });

    const rows = new Map([...(await store.list({}, { limit: 50, offset: 0 })).items.map((row) => [row.id, row] as const)]);
    expect(rows.get("run:cart:Balogun:buyer:1:dispatch:0")!.status).toBe("completed");
    expect(rows.get("run:cart:Balogun:buyer:1:dispatch:1")!.status).toBe("failed");
    expect(rows.get("run:cart:Balogun:buyer:1:dispatch:1")!.failureReason).toBe("Account resolve failed");
    expect(rows.get("run:cart:Balogun:buyer:1:dispatch:1")!.failureRetryable).toBe(false);
    expect(rows.get("run:cart:Balogun:buyer:1:dispatch:2")!.status).toBe("queued"); // still in-flight
    expect(rows.get("fresh:dispatch")!.status).toBe("queued"); // too fresh to sync
    // Sync is not a re-execution: attempts never moved.
    expect(rows.get("run:cart:Balogun:buyer:1:dispatch:0")!.attempts).toBe(1);
  });
});

describe("consumer with the completed status", () => {
  it("skips completed rows on redelivery (terminal — never re-dispatched)", async () => {
    const store = new InMemoryDispatchStore();
    const request = sampleDispatchRequest();
    let calls = 0;
    const counting: PaymentDispatcher = {
      async dispatchTransfer(): Promise<DispatchTransferResult> {
        calls += 1;
        return { status: "queued", providerRef: "flw:1" };
      },
    };
    // First delivery: all legs dispatch and land queued; then a webhook
    // completes leg 0.
    await handleDispatchRequested(store, counting, new FakeMessage("m-1"), request);
    expect(calls).toBe(3);
    await store.recordStatus("run:cart:Balogun:buyer:1:dispatch:0", { status: "completed" });

    // Redelivery: completed and queued legs are both skipped.
    await handleDispatchRequested(store, counting, new FakeMessage("m-2"), request);
    expect(calls).toBe(3);
    expect((await store.byId("run:cart:Balogun:buyer:1:dispatch:0"))!.status).toBe("completed");
  });
});
