import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The WebSocket gateway rides the same Hono routes as everything else: an
 * upgrade request forwards to the owning DO and the 101 (with the client end
 * of the socket pair) passes straight back through the app.
 */
describe("WebSocket gateway through the Hono app", () => {
  it("upgrades /markets/:market and delivers live events", async () => {
    const upgrade = await SELF.fetch(
      new Request("http://edge/markets/wsg", { headers: { upgrade: "websocket" } }),
    );
    expect(upgrade.status).toBe(101);
    const ws = upgrade.webSocket;
    if (!ws) throw new Error("no client socket in the 101 response");
    ws.accept();

    const events: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (event) => {
      events.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });

    // A client command through the same app reaches the socket attached to
    // the market scope.
    const posted = await SELF.fetch(new Request("http://edge/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "intent.posted",
        intentId: "wsg-intent-1",
        shopItem: "Tomatoes",
        quantity: 2,
        unit: "kg",
        priceBand: { minKobo: 120_000, maxKobo: 180_000 },
        market: "wsg",
        buyerId: "buyer:ws",
      }),
    }));
    expect(posted.status).toBe(200);

    const recorded = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("intent.recorded never arrived")), 3_000);
      const poll = () => {
        const found = events.find((event) => event.type === "intent.recorded");
        if (found) {
          clearTimeout(timer);
          resolve(found);
        } else {
          setTimeout(poll, 25);
        }
      };
      poll();
    });
    expect((recorded.intent as { id: string }).id).toBe("wsg-intent-1");
    ws.close();
  });
});
