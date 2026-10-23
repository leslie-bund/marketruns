import { describe, expect, it } from "vitest";
import { handleDispatchRequested, retryDelaySeconds } from "../src/consume.js";
import { StubDispatcher, type DispatchTransferResult, type PaymentDispatcher } from "../src/dispatcher.js";
import {
  FakeMessage,
  InMemoryDispatchStore,
  InMemoryHoldStore,
  sampleDispatchRequest,
  sampleHold,
} from "./helpers.js";

/** Dispatcher double whose per-leg results are scripted by partyId. */
class ScriptedDispatcher implements PaymentDispatcher {
  readonly calls: Array<{ idempotencyKey: string; partyId: string; amountKobo: number }> = [];
  constructor(private readonly results: Record<string, DispatchTransferResult>) {}
  async dispatchTransfer(request: {
    idempotencyKey: string;
    recipient: { partyId: string; account: "seller" | "runner" | "platform" };
    amountKobo: number;
    memo: string;
  }): Promise<DispatchTransferResult> {
    this.calls.push({
      idempotencyKey: request.idempotencyKey,
      partyId: request.recipient.partyId,
      amountKobo: request.amountKobo,
    });
    return this.results[request.recipient.partyId] ?? { status: "sent", providerRef: "scripted:ok" };
  }
}

describe("payment dispatch consumer", () => {
  it("persists every leg, dispatches each once, and acks", async () => {
    const store = new InMemoryDispatchStore();
    const dispatcher = new StubDispatcher();
    const message = new FakeMessage("m-1");

    await handleDispatchRequested(store, dispatcher, message, sampleDispatchRequest());

    expect(store.rows.size).toBe(3);
    const rows = [...store.rows.values()];
    expect(rows.every((row) => row.status === "sent")).toBe(true);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
    expect(rows.every((row) => row.providerRef?.startsWith("stub:"))).toBe(true);
    expect(rows.map((row) => row.id).sort()).toEqual([
      "run:cart:Balogun:buyer:1:dispatch:0",
      "run:cart:Balogun:buyer:1:dispatch:1",
      "run:cart:Balogun:buyer:1:dispatch:2",
    ]);
    expect(message.acked).toBe(true);
    expect(message.retries).toHaveLength(0);
  });

  it("is idempotent: duplicate delivery adds no rows and dispatches nothing twice", async () => {
    const store = new InMemoryDispatchStore();
    const dispatcher = new ScriptedDispatcher({});
    const request = sampleDispatchRequest();

    await handleDispatchRequested(store, dispatcher, new FakeMessage("m-1"), request);
    const replay = new FakeMessage("m-2");
    await handleDispatchRequested(store, dispatcher, replay, request);

    expect(store.rows.size).toBe(3);
    expect(dispatcher.calls).toHaveLength(3); // only the first delivery dispatched
    expect(replay.acked).toBe(true);
    expect([...store.rows.values()].every((row) => row.attempts === 1)).toBe(true);
  });

  it("failure → retry with backoff, failed status visible, then redelivery re-dispatches only the failed leg", async () => {
    const store = new InMemoryDispatchStore();
    const failing = new ScriptedDispatcher({
      "runner:internal": { status: "failed", failureReason: "provider timeout" },
    });

    const first = new FakeMessage("m-1");
    await handleDispatchRequested(store, failing, first, sampleDispatchRequest());

    expect(first.acked).toBe(false);
    expect(first.retries).toEqual([{ delaySeconds: 30 }]); // attempts=1 → 30s × 2^0
    const rows = [...store.rows.values()];
    const byParty = new Map(rows.map((row) => [row.partyId, row]));
    expect(byParty.get("seller:amina")?.status).toBe("sent");
    expect(byParty.get("runner:internal")?.status).toBe("failed");
    expect(byParty.get("runner:internal")?.failureReason).toBe("provider timeout");
    expect(byParty.get("runner:internal")?.failureRetryable).toBe(true);
    expect(byParty.get("platform")?.status).toBe("sent");

    // Queue redelivery after the retry delay: the runner leg recovers.
    const recovering = new ScriptedDispatcher({});
    const second = new FakeMessage("m-2");
    await handleDispatchRequested(store, recovering, second, sampleDispatchRequest());

    expect(store.rows.size).toBe(3); // still one row per leg
    expect(recovering.calls).toHaveLength(1);
    expect(recovering.calls[0]?.partyId).toBe("runner:internal");
    expect(store.rows.get("run:cart:Balogun:buyer:1:dispatch:1")?.status).toBe("sent");
    expect(store.rows.get("run:cart:Balogun:buyer:1:dispatch:1")?.attempts).toBe(2);
    expect(second.acked).toBe(true);
  });

  it("terminal failure → ack without retry, keeps the hold held, and never re-dispatches on replay", async () => {
    const store = new InMemoryDispatchStore();
    const holds = new InMemoryHoldStore();
    const hold = sampleHold({ runId: sampleDispatchRequest().runId });
    await holds.insertIfAbsent(hold);
    const failing = new ScriptedDispatcher({
      "runner:internal": {
        status: "failed",
        failureReason: "recipient-unresolved",
        retryable: false,
      },
    });

    const first = new FakeMessage("m-1");
    await handleDispatchRequested(store, failing, first, sampleDispatchRequest(), holds);

    expect(first.acked).toBe(true);
    expect(first.retries).toHaveLength(0);
    expect(store.rows.get("run:cart:Balogun:buyer:1:dispatch:1")?.status).toBe("failed");
    expect(store.rows.get("run:cart:Balogun:buyer:1:dispatch:1")?.failureRetryable).toBe(false);
    expect((await holds.byId(hold.id))?.status).toBe("held");

    // A redelivery must not burn attempts on a deterministic rejection or
    // release the hold; only an operator replay after a fix may do that.
    const replay = new FakeMessage("m-2");
    await handleDispatchRequested(store, failing, replay, sampleDispatchRequest(), holds);

    expect(failing.calls).toHaveLength(3); // only the first delivery dispatched
    expect(store.rows.get("run:cart:Balogun:buyer:1:dispatch:1")?.attempts).toBe(1);
    expect(replay.acked).toBe(true);
    expect((await holds.byId(hold.id))?.status).toBe("held");
  });

  it("re-dispatches legs left pending by a crash between insert and dispatch", async () => {
    const store = new InMemoryDispatchStore();
    // Simulate a crash: seed the pending rows without any dispatch attempt.
    const request = sampleDispatchRequest();
    const { dispatchRow } = await import("../src/store.js");
    for (let index = 0; index < request.legs.length; index += 1) {
      await store.insertPending(dispatchRow(request, index));
    }

    const dispatcher = new ScriptedDispatcher({});
    const message = new FakeMessage("m-1");
    await handleDispatchRequested(store, dispatcher, message, request);

    expect(dispatcher.calls).toHaveLength(3);
    expect([...store.rows.values()].every((row) => row.status === "sent")).toBe(true);
    expect(message.acked).toBe(true);
  });
});

describe("retryDelaySeconds", () => {
  it("grows exponentially from 30s and caps at 600s", () => {
    expect(retryDelaySeconds(1)).toBe(30);
    expect(retryDelaySeconds(2)).toBe(60);
    expect(retryDelaySeconds(3)).toBe(120);
    expect(retryDelaySeconds(4)).toBe(240);
    expect(retryDelaySeconds(5)).toBe(480);
    expect(retryDelaySeconds(6)).toBe(600);
    expect(retryDelaySeconds(20)).toBe(600);
  });
});
