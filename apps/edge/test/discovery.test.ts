import { runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { STATE_KEY } from "../src/do/state.js";
import { internalPost, marketStub, offerProduct, productStub, shiftTime } from "./helpers.js";

/**
 * The filtered discovery read (proto/discovery.ts): open intents scoped to the
 * caller with their live products inline — sellers by shop items (ADR-0006),
 * buyers by their own identity. Plus the discovery-index lifecycle: the
 * intentProducts map dies with its intents instead of leaking forever.
 */

async function postIntent(intentId: string, market: string, shopItem: string, buyerId?: string): Promise<void> {
  const response = await marketStub(market).fetch(
    internalPost("/intent", {
      type: "intent.posted",
      intentId,
      shopItem,
      quantity: 2,
      unit: "kg",
      priceBand: { minKobo: 120_000, maxKobo: 180_000 },
      market,
      ...(buyerId !== undefined ? { buyerId } : {}),
    }),
  );
  expect(response.status).toBe(200);
}

interface DiscoveryEntry {
  intent: { id: string; shopItem: string; buyerId?: string };
  products: Array<{ id: string; status: string; sellerName: string }>;
}

async function discovery(path: string, headers?: Record<string, string>): Promise<DiscoveryEntry[]> {
  const response = await SELF.fetch(new Request(`http://edge${path}`, { headers }));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { intents: DiscoveryEntry[] };
  return body.intents;
}

describe("MarketDO discovery read", () => {
  it("seller scope returns only matching intents, with live products inline", async () => {
    const market = "disc-seller";
    await postIntent("disc-s-intent-tomato", market, "Tomatoes", "buyer:ada");
    await postIntent("disc-s-intent-pepper", market, "Peppers", "buyer:ada");
    expect((await offerProduct("disc-s-product-1", "disc-s-intent-tomato", market)).status).toBe(200);

    const tomato = await discovery(`/markets/${market}/discovery?shopItems=${encodeURIComponent("Tomatoes")}`);
    expect(tomato.map((entry) => entry.intent.id).sort()).toEqual(["disc-s-intent-tomato"]);
    // The product is inlined in the same response — no per-intent fan-out.
    expect(tomato[0]?.products.map((product) => product.id)).toEqual(["disc-s-product-1"]);
    expect(tomato[0]?.products[0]?.status).toBe("available");
    expect(tomato[0]?.products[0]?.sellerName).toBe("Amina's Fresh Store");

    const pepper = await discovery(`/markets/${market}/discovery?shopItems=Peppers`);
    expect(pepper.map((entry) => entry.intent.id)).toEqual(["disc-s-intent-pepper"]);
    expect(pepper[0]?.products).toEqual([]);

    // The vocabulary match is case-insensitive, same as the /intents scope.
    const lower = await discovery(`/markets/${market}/discovery?shopItems=tomatoes`);
    expect(lower.map((entry) => entry.intent.id)).toEqual(["disc-s-intent-tomato"]);
  });

  it("empty or absent scope returns nothing — discovery is the filtered pathway", async () => {
    const market = "disc-empty";
    await postIntent("disc-e-intent-1", market, "Tomatoes", "buyer:ada");

    expect(await discovery(`/markets/${market}/discovery?shopItems=`)).toEqual([]);
    expect(await discovery(`/markets/${market}/discovery?shopItems=${encodeURIComponent("Yams")}`)).toEqual([]);
    expect(await discovery(`/markets/${market}/discovery`)).toEqual([]);
  });

  it("buyer scope returns only the caller's own intents — by query param or identity header", async () => {
    const market = "disc-buyer";
    await postIntent("disc-b-intent-ada-1", market, "Tomatoes", "buyer:ada");
    await postIntent("disc-b-intent-ada-2", market, "Peppers", "buyer:ada");
    await postIntent("disc-b-intent-biyi", market, "Tomatoes", "buyer:biyi");
    expect((await offerProduct("disc-b-product-1", "disc-b-intent-ada-1", market)).status).toBe(200);

    const ada = await discovery(`/markets/${market}/discovery?buyerId=${encodeURIComponent("buyer:ada")}`);
    expect(ada.map((entry) => entry.intent.id).sort()).toEqual(["disc-b-intent-ada-1", "disc-b-intent-ada-2"]);
    const withProducts = ada.find((entry) => entry.intent.id === "disc-b-intent-ada-1");
    expect(withProducts?.products.map((product) => product.id)).toEqual(["disc-b-product-1"]);

    // The header seam form (ADR-0015): the edge forwards the caller's identity
    // headers verbatim and the MarketDO scopes by them.
    const viaHeader = await discovery(`/markets/${market}/discovery`, { "x-participant-id": "buyer:biyi" });
    expect(viaHeader.map((entry) => entry.intent.id)).toEqual(["disc-b-intent-biyi"]);

    // Both filters given: they intersect.
    const both = await discovery(
      `/markets/${market}/discovery?shopItems=Peppers&buyerId=${encodeURIComponent("buyer:ada")}`,
    );
    expect(both.map((entry) => entry.intent.id)).toEqual(["disc-b-intent-ada-2"]);
  });

  it("retired products never appear inline (products are retired, never resurrected)", async () => {
    const market = "disc-retired";
    await postIntent("disc-r-intent-1", market, "Tomatoes", "buyer:ada");
    expect((await offerProduct("disc-r-product-1", "disc-r-intent-1", market)).status).toBe(200);

    // Retire the product directly at its DO.
    const retired = await productStub("disc-r-product-1").fetch(internalPost("/retire", { reason: "withdrawn" }));
    expect(retired.status).toBe(200);

    const entries = await discovery(`/markets/${market}/discovery?shopItems=Tomatoes`);
    expect(entries.map((entry) => entry.intent.id)).toEqual(["disc-r-intent-1"]);
    expect(entries[0]?.products).toEqual([]);
  });
});

describe("MarketDO discovery-index lifecycle", () => {
  it("the intentProducts map dies with its intents at expiry — no leak", async () => {
    const market = "disc-prune";
    await postIntent("disc-p-intent-1", market, "Tomatoes", "buyer:ada");
    expect((await offerProduct("disc-p-product-1", "disc-p-intent-1", market)).status).toBe(200);

    const stub = marketStub(market);
    // Index populated, plus an orphan key from "before pruning existed".
    await runInDurableObject(stub, async (_instance, state) => {
      const stored = (await state.storage.get<{ intentProducts: Record<string, string[]> }>(STATE_KEY))!;
      expect(Object.keys(stored.intentProducts)).toContain("disc-p-intent-1");
      stored.intentProducts["disc-p-ghost"] = ["disc-p-product-ghost"];
      await state.storage.put(STATE_KEY, stored);
    });

    // Move the market clock past the intent TTL and run the real alarm.
    await shiftTime(stub, 31 * 60 * 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async (_instance, state) => {
      const stored = (await state.storage.get<{ intents: unknown[]; intentProducts: Record<string, string[]> }>(STATE_KEY))!;
      expect(stored.intents).toEqual([]);
      expect(stored.intentProducts).toEqual({});
    });

    // The discovery read agrees: nothing left to discover.
    expect(await discovery(`/markets/${market}/discovery?shopItems=Tomatoes`)).toEqual([]);
  });

  it("other intents' index entries survive a neighbour's expiry", async () => {
    const market = "disc-prune-keep";
    await postIntent("disc-k-intent-1", market, "Tomatoes", "buyer:ada");
    expect((await offerProduct("disc-k-product-1", "disc-k-intent-1", market)).status).toBe(200);

    const stub = marketStub(market);
    // A second intent posted "later" — shift the clock, post, shift back is
    // not possible (offset is absolute), so post both now and expire only the
    // first by rewriting its expiresAt to the past inside the alarm window.
    await postIntent("disc-k-intent-2", market, "Tomatoes", "buyer:ada");
    expect((await offerProduct("disc-k-product-2", "disc-k-intent-2", market)).status).toBe(200);

    await runInDurableObject(stub, async (_instance, state) => {
      const stored = (await state.storage.get<{ intents: Array<{ intent: { id: string }; expiresAt: number }> }>(STATE_KEY))!;
      for (const entry of stored.intents) {
        if (entry.intent.id === "disc-k-intent-1") entry.expiresAt = Date.now() - 1;
      }
      await state.storage.put(STATE_KEY, stored);
    });
    // An alarm is already scheduled for the intents' TTLs; rewriting expiresAt
    // doesn't reschedule, so run the alarm now via the test seam after arming
    // it: posting above armed one — force it with a no-op fetch then run.
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async (_instance, state) => {
      const stored = (await state.storage.get<{
        intents: Array<{ intent: { id: string } }>;
        intentProducts: Record<string, string[]>;
      }>(STATE_KEY))!;
      expect(stored.intents.map((entry) => entry.intent.id)).toEqual(["disc-k-intent-2"]);
      expect(Object.keys(stored.intentProducts)).toEqual(["disc-k-intent-2"]);
    });
  });
});
