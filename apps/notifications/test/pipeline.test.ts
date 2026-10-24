import { describe, expect, it, vi } from "vitest";
import type { NotificationTransition } from "@market-runs/proto";
import { createNotificationsApp } from "../src/app.js";
import { consumeNotificationMessage, type QueueMessageLike } from "../src/consumer.js";
import { MemoryNotificationStore } from "../src/memory-store.js";
import type { NotificationProviders } from "../src/provider.js";

function transition(): NotificationTransition {
  return {
    sourceEventId: "payment.hold-placed:hold:1",
    sourceEventType: "payment.hold-placed",
    recipientId: "buyer:1",
    dedupeKey: "payment.hold-placed:hold:1:buyer:1",
    category: "payment",
    title: "Payment hold confirmed",
    body: "Your payment is held.",
    deepLink: "/buyer/cart",
    data: { cartId: "cart:1" },
    occurredAt: 1000,
    email: "receipt",
  };
}

function message(body: unknown): QueueMessageLike & { ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> } {
  return { id: "message:1", body, ack: vi.fn(), retry: vi.fn() };
}

describe("notification pipeline", () => {
  it("dedupes source replays across durable and outbox rows", async () => {
    const store = new MemoryNotificationStore();
    const providers: NotificationProviders = {
      websocket: vi.fn(async () => ({ kind: "delivered" as const })),
      email: vi.fn(async () => ({ kind: "delivered" as const, providerRef: "email:1" })),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const incoming = message(transition());
      await consumeNotificationMessage(store, providers, incoming);
      expect(incoming.ack).toHaveBeenCalledOnce();
    }
    expect(store.notifications.size).toBe(1);
    expect(store.outbox.size).toBe(2);
    expect(providers.websocket).toHaveBeenCalledOnce();
    expect(providers.email).toHaveBeenCalledOnce();
  });

  it("retries a failed provider without duplicating the notification", async () => {
    const store = new MemoryNotificationStore();
    const providers: NotificationProviders = {
      websocket: vi.fn(async () => ({ kind: "delivered" as const })),
      email: vi.fn()
        .mockResolvedValueOnce({ kind: "retry" as const, error: "sandbox unavailable" })
        .mockResolvedValueOnce({ kind: "delivered" as const }),
    };
    const first = message(transition());
    await consumeNotificationMessage(store, providers, first);
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    const second = message(transition());
    await consumeNotificationMessage(store, providers, second);
    expect(second.ack).toHaveBeenCalledOnce();
    expect(store.notifications.size).toBe(1);
    expect([...store.outbox.values()].every((row) => row.status === "delivered")).toBe(true);
  });

  it("scopes reads and read-state writes to the recipient", async () => {
    const store = new MemoryNotificationStore();
    await store.ingest([transition()]);
    const app = createNotificationsApp(store, {
      websocket: async () => ({ kind: "skipped", error: "test" }),
      email: async () => ({ kind: "skipped", error: "test" }),
    });
    const list = await app.fetch(new Request("http://worker/notifications", { headers: { "x-participant-id": "buyer:1" } }));
    expect(list.status).toBe(200);
    const body = await list.json() as { items: Array<{ id: string }>; unread: number };
    expect(body.unread).toBe(1);
    const other = await app.fetch(new Request("http://worker/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json", "x-participant-id": "buyer:2" },
      body: JSON.stringify({ ids: [body.items[0]?.id] }),
    }));
    expect(await other.json()).toEqual({ updated: 0 });
    const own = await app.fetch(new Request("http://worker/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json", "x-participant-id": "buyer:1" },
      body: JSON.stringify({ ids: [body.items[0]?.id] }),
    }));
    expect(await own.json()).toEqual({ updated: 1 });
  });
});
