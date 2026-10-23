import { describe, expect, it } from "vitest";
import { createPaymentsApp } from "../src/index.js";
import { StubDispatcher, type DispatchTransferResult, type PaymentDispatcher } from "../src/dispatcher.js";
import { dispatchRow } from "../src/store.js";
import { InMemoryDispatchStore, sampleDispatchRequest } from "./helpers.js";

class ScriptedDispatcher implements PaymentDispatcher {
  constructor(private readonly result: DispatchTransferResult) {}
  async dispatchTransfer(): Promise<DispatchTransferResult> {
    return this.result;
  }
}

async function seededStore(status: "pending" | "sent" | "failed" = "failed") {
  const store = new InMemoryDispatchStore();
  const request = sampleDispatchRequest();
  for (let index = 0; index < request.legs.length; index += 1) {
    const row = dispatchRow(request, index);
    await store.insertPending(row);
    if (status !== "pending") {
      await store.recordResult(row.id, {
        status: status === "sent" ? "sent" : "failed",
        ...(status === "sent" ? { providerRef: "stub:seeded" } : { failureReason: "provider timeout" }),
      });
    }
  }
  return store;
}

describe("payments HTTP surface", () => {
  it("GET /healthz reports the service and the active dispatcher", async () => {
    const app = createPaymentsApp(new InMemoryDispatchStore(), new StubDispatcher(), {
      dispatcherKind: "stub",
    });
    const response = await app.fetch(new Request("http://payments/healthz"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "market-runs-payments", dispatcher: "stub" });
  });

  it("GET /dispatches lists views, filterable by runId and status", async () => {
    const store = new InMemoryDispatchStore();
    const request = sampleDispatchRequest();
    for (let index = 0; index < request.legs.length; index += 1) {
      const row = dispatchRow(request, index);
      await store.insertPending(row);
      await store.recordResult(row.id, index === 1 ? { status: "failed", failureReason: "boom" } : { status: "sent", providerRef: `stub:${index}` });
    }
    const app = createPaymentsApp(store, new StubDispatcher());

    const all = await app.fetch(new Request("http://payments/dispatches"));
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as { items: Array<{ id: string; status: string; createdAt: number }>; total: number };
    expect(allBody.total).toBe(3);
    expect(allBody.items[0]?.createdAt).toBeGreaterThan(0);

    const failedOnly = await app.fetch(new Request("http://payments/dispatches?status=failed"));
    const failedBody = (await failedOnly.json()) as { items: Array<{ partyId: string }>; total: number };
    expect(failedBody.total).toBe(1);
    expect(failedBody.items[0]?.partyId).toBe("runner:internal");

    const otherRun = await app.fetch(new Request("http://payments/dispatches?runId=run:cart:Balogun:buyer:2"));
    expect(((await otherRun.json()) as { total: number }).total).toBe(0);

    const byRun = await app.fetch(new Request("http://payments/dispatches?runId=run:cart:Balogun:buyer:1&status=sent"));
    expect(((await byRun.json()) as { total: number }).total).toBe(2);
  });

  it("GET /dispatches rejects bad status and paging params", async () => {
    const app = createPaymentsApp(new InMemoryDispatchStore(), new StubDispatcher());
    const badStatus = await app.fetch(new Request("http://payments/dispatches?status=bogus"));
    expect(badStatus.status).toBe(400);
    expect(((await badStatus.json()) as { error: string }).error).toBe("invalid-query");
    expect((await app.fetch(new Request("http://payments/dispatches?limit=0"))).status).toBe(400);
    expect((await app.fetch(new Request("http://payments/dispatches?offset=-1"))).status).toBe(400);
  });

  it("POST /dispatches/:id/replay re-dispatches a failed row through the dispatcher", async () => {
    const store = await seededStore("failed");
    const app = createPaymentsApp(store, new StubDispatcher());

    const response = await app.fetch(
      new Request("http://payments/dispatches/run:cart:Balogun:buyer:1:dispatch:1/replay", { method: "POST" }),
    );
    expect(response.status).toBe(200);
    const view = (await response.json()) as { status: string; providerRef: string; attempts: number };
    expect(view.status).toBe("sent");
    expect(view.providerRef).toMatch(/^stub:/);
    expect(view.attempts).toBe(2); // the failed attempt plus the replay
  });

  it("replay 409s an already-sent row and 404s an unknown id", async () => {
    const store = await seededStore("sent");
    const app = createPaymentsApp(store, new StubDispatcher());

    const conflict = await app.fetch(
      new Request("http://payments/dispatches/run:cart:Balogun:buyer:1:dispatch:0/replay", { method: "POST" }),
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toBe("already-dispatched");

    const missing = await app.fetch(new Request("http://payments/dispatches/nope/replay", { method: "POST" }));
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("not-found");
  });

  it("replay that fails again returns 502 with the still-failed view", async () => {
    const store = await seededStore("failed");
    const app = createPaymentsApp(store, new ScriptedDispatcher({ status: "failed", failureReason: "still down" }));

    const response = await app.fetch(
      new Request("http://payments/dispatches/run:cart:Balogun:buyer:1:dispatch:0/replay", { method: "POST" }),
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string; dispatch: { status: string; attempts: number } };
    expect(body.error).toBe("dispatch-failed");
    expect(body.dispatch.status).toBe("failed");
    expect(body.dispatch.attempts).toBe(2);
  });

  it("unknown routes 404 in the wire error shape", async () => {
    const app = createPaymentsApp(new InMemoryDispatchStore(), new StubDispatcher());
    const response = await app.fetch(new Request("http://payments/nope"));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("not-found");
  });
});
