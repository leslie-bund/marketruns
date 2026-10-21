import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Topic-filtered broadcast (the doctrine: buyers only ask for what they typed,
 * sellers only get intents for items they've listed — item filtering is the
 * /discovery read's job; topics classify events). A socket only receives
 * events whose topics intersect its subscribed topics; sockets that never
 * subscribe are legacy full-subscribe and keep receiving everything.
 */

interface TestSocket {
  ws: WebSocket;
  events: Array<Record<string, unknown>>;
}

async function openSocket(market: string, topics?: string[]): Promise<TestSocket> {
  const upgrade = await SELF.fetch(new Request(`http://edge/markets/${market}`, { headers: { upgrade: "websocket" } }));
  expect(upgrade.status).toBe(101);
  const ws = upgrade.webSocket;
  if (!ws) throw new Error("no client socket in the 101 response");
  ws.accept();
  const socket: TestSocket = { ws, events: [] };
  ws.addEventListener("message", (event) => {
    socket.events.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  });
  if (topics !== undefined) {
    ws.send(JSON.stringify({ type: "subscribe", topics }));
    // The subscribe must land before any broadcast we assert on; the ack proves it.
    await waitFor(socket, "subscribed");
  }
  return socket;
}

async function waitFor(socket: TestSocket, type: string, timeoutMs = 3_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} never arrived`)), timeoutMs);
    const poll = () => {
      const found = socket.events.find((event) => event.type === type);
      if (found) {
        clearTimeout(timer);
        resolve(found);
      } else {
        setTimeout(poll, 25);
      }
    };
    poll();
  });
}

/** Give non-delivery a fair chance, then assert the event type never arrived. */
async function expectSilent(socket: TestSocket, type: string, quietMs = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, quietMs));
  expect(socket.events.some((event) => event.type === type)).toBe(false);
}

async function postIntent(intentId: string, market: string): Promise<void> {
  const response = await SELF.fetch(
    new Request("http://edge/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "intent.posted",
        intentId,
        shopItem: "Tomatoes",
        quantity: 2,
        unit: "kg",
        priceBand: { minKobo: 120_000, maxKobo: 180_000 },
        market,
        buyerId: "buyer:topics",
      }),
    }),
  );
  expect(response.status).toBe(200);
}

async function registerStore(storeId: string, market: string): Promise<void> {
  const response = await SELF.fetch(
    new Request("http://edge/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "store.registered",
        storeId,
        market,
        name: "Topic Test Store",
        exchangePoint: "Topic Market, Stall T1",
        shopItems: ["Tomatoes"],
      }),
    }),
  );
  expect(response.status).toBe(200);
}

describe("topic-filtered broadcast on the market scope", () => {
  it("delivers intent.recorded to `intents` subscribers and legacy sockets, not to `market`-only sockets", async () => {
    const market = "topic-intents";
    const seller = await openSocket(market, ["intents"]);
    const configWatcher = await openSocket(market, ["market"]);
    const legacy = await openSocket(market);

    await postIntent("topic-intent-1", market);

    const recorded = await waitFor(seller, "intent.recorded");
    expect((recorded.intent as { id: string }).id).toBe("topic-intent-1");
    await waitFor(legacy, "intent.recorded");
    await expectSilent(configWatcher, "intent.recorded");

    seller.ws.close();
    configWatcher.ws.close();
    legacy.ws.close();
  });

  it("delivers store.recorded to `market` subscribers and legacy sockets, not to `intents`-only sockets", async () => {
    const market = "topic-market";
    const seller = await openSocket(market, ["intents"]);
    const configWatcher = await openSocket(market, ["market"]);
    const legacy = await openSocket(market);

    await registerStore("topic-store-1", market);

    const recorded = await waitFor(configWatcher, "store.recorded");
    expect((recorded.store as { id: string }).id).toBe("topic-store-1");
    await waitFor(legacy, "store.recorded");
    await expectSilent(seller, "store.recorded");

    seller.ws.close();
    configWatcher.ws.close();
    legacy.ws.close();
  });

  it("delivers intent lifecycle to a buyer's `intent:<id>` topic without the market-wide `intents` topic", async () => {
    const market = "topic-buyer";
    const buyer = await openSocket(market, ["intent:topic-buyer-intent-1"]);
    const otherBuyer = await openSocket(market, ["intent:topic-buyer-intent-2"]);

    await postIntent("topic-buyer-intent-1", market);

    // The buyer hears their own intent's lifecycle...
    const recorded = await waitFor(buyer, "intent.recorded");
    expect((recorded.intent as { id: string }).id).toBe("topic-buyer-intent-1");
    // ...and a buyer subscribed to a different intent does not.
    await expectSilent(otherBuyer, "intent.recorded");

    buyer.ws.close();
    otherBuyer.ws.close();
  });
});
