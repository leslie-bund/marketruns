import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { internalPost, marketStub, postIntent, readJson } from "./helpers.js";

/**
 * The store registry and the market vocabulary it grows (GLOSSARY: Store,
 * Shop Item; ADR-0006): sellers register stores with their shop items, the
 * vocabulary is the union of what stores supply, and intents scope to the
 * stores whose items match — the rooms that bound intent fan-out.
 */
describe("MarketDO store registry and vocabulary scoping", () => {
  it("registers stores idempotently and grows the vocabulary from their shop items", async () => {
    const register = () =>
      marketStub("sr").fetch(
        internalPost("/store", {
          type: "store.registered",
          storeId: "sr-store-1",
          market: "sr",
          name: "Amina's Fresh Store",
          exchangePoint: "sr Market, Stall B14",
          shopItems: ["Tomatoes", "Peppers"],
        }),
      );

    const first = await register();
    expect(first.status).toBe(200);
    expect((await readJson(first)).type).toBe("store.recorded");

    // Idempotent replay: same storeId, same store, no duplicate.
    const replay = await register();
    expect(replay.status).toBe(200);
    const stores = await marketStub("sr").fetch(new Request("http://do/stores"));
    expect(((await readJson(stores)).stores as unknown[]).length).toBe(1);

    await marketStub("sr").fetch(
      internalPost("/store", {
        type: "store.registered",
        storeId: "sr-store-2",
        market: "sr",
        name: "Chidi's Grains",
        exchangePoint: "sr Market, Stall A02",
        shopItems: ["Rice", "Peppers"],
      }),
    );

    const vocabulary = await marketStub("sr").fetch(new Request("http://do/vocabulary"));
    expect((await readJson(vocabulary)).shopItems).toEqual(["Peppers", "Rice", "Tomatoes"]);
  });

  it("scopes open intents to a store's shop items; unscoped reads stay global", async () => {
    await postIntent("sr-intent-tomatoes", "sr"); // shopItem "Tomatoes"
    await marketStub("sr").fetch(
      internalPost("/intent", {
        type: "intent.posted",
        intentId: "sr-intent-yam",
        shopItem: "Yam",
        quantity: 1,
        unit: "tuber",
        priceBand: { minKobo: 50_000, maxKobo: 90_000 },
        market: "sr",
      }),
    );

    const scoped = await marketStub("sr").fetch(new Request("http://do/intents?shopItems=Tomatoes"));
    const scopedIntents = (await readJson(scoped)).intents as Array<{ id: string }>;
    expect(scopedIntents.map((intent) => intent.id)).toEqual(["sr-intent-tomatoes"]);

    const global = await marketStub("sr").fetch(new Request("http://do/intents"));
    expect(((await readJson(global)).intents as unknown[]).length).toBe(2);
  });

  it("recovers only the caller's owned store for the market", async () => {
    const sellerHeaders = { "x-participant-id": "seller-recovery", "x-participant-role": "seller" };
    const registered = await SELF.fetch(new Request("http://edge/command", {
      method: "POST",
      headers: { "content-type": "application/json", ...sellerHeaders },
      body: JSON.stringify({
        type: "store.registered",
        storeId: "store-recovery",
        market: "recovery-market",
        name: "Recovered Store",
        exchangePoint: "Stall 1",
        shopItems: ["Rice"],
      }),
    }));
    expect(registered.status).toBe(200);

    const recovered = await SELF.fetch(new Request("http://edge/markets/recovery-market/store", { headers: sellerHeaders }));
    expect(recovered.status).toBe(200);
    const store = (await readJson(recovered)).store as { id: string; sellerParticipantId: string };
    expect(store.id).toBe("store-recovery");
    expect(store.sellerParticipantId).toBe("seller-recovery");

    const otherSeller = await SELF.fetch(new Request("http://edge/markets/recovery-market/store", {
      headers: { "x-participant-id": "seller-other", "x-participant-role": "seller" },
    }));
    expect(otherSeller.status).toBe(404);
  });
});
