import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { createApp } from "../src/app/app.js";
import { bindings, internalPost, marketStub, readJson } from "./helpers.js";

const BASE = "http://edge";

/**
 * Vocabulary moderation (ADR-0006 — the platform curates normalization and
 * synonyms, not a canon): ops removes or renames shop items across every
 * store in a market, case-insensitively, via the ops console API backed by
 * the MarketDO's /moderate-vocabulary write.
 */
function registerStore(market: string, storeId: string, name: string, shopItems: string[]): Promise<Response> {
  return marketStub(market).fetch(
    internalPost("/store", {
      type: "store.registered",
      storeId,
      market,
      name,
      exchangePoint: `${market} Market, Stall B14`,
      shopItems,
    }),
  );
}

/** Joining registers the market, making it a known zone for the ops routes. */
function joinMarket(market: string, participantId: string): Promise<Response> {
  return marketStub(market).fetch(
    internalPost("/join", { type: "market.joined", market, participantId, role: "seller" }),
  );
}

function moderate(market: string, body: unknown): Promise<Response> {
  return marketStub(market).fetch(internalPost("/moderate-vocabulary", body));
}

async function vocabulary(market: string): Promise<string[]> {
  const response = await marketStub(market).fetch(new Request("http://do/vocabulary"));
  return (await readJson(response)).shopItems as string[];
}

interface AffectedStore {
  id: string;
  name: string;
}

function postJson(path: string, body: unknown, headers?: Headers): Promise<Response> {
  const all = new Headers(headers);
  all.set("content-type", "application/json");
  return SELF.fetch(new Request(`${BASE}${path}`, { method: "POST", headers: all, body: JSON.stringify(body) }));
}

/** An env that behaves like the test bindings but with OPS_TOKEN set. */
function withOpsToken(token: string): Env {
  return new Proxy(bindings, {
    get: (target, prop, receiver) => (prop === "OPS_TOKEN" ? token : Reflect.get(target, prop, receiver)),
  }) as Env;
}

describe("MarketDO vocabulary moderation", () => {
  it("remove deletes the item across stores case-insensitively; a zero-item store survives", async () => {
    await registerStore("vm-rm", "vm-rm-store-1", "Amina's Fresh Store", ["Tomatoes", "Peppers"]);
    await registerStore("vm-rm", "vm-rm-store-2", "Chidi's Grains", ["tomatoes", "Rice"]);
    expect(await vocabulary("vm-rm")).toEqual(["Tomatoes", "Peppers", "tomatoes", "Rice"].sort((a, b) => a.localeCompare(b)));

    const response = await moderate("vm-rm", { action: "remove", item: "TOMATOES" });
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.vocabulary).toEqual(["Peppers", "Rice"]);
    const affected = body.affectedStores as AffectedStore[];
    expect(affected.map((store) => store.id).sort()).toEqual(["vm-rm-store-1", "vm-rm-store-2"]);

    // The zero-item store stays registered — it just stops matching intents.
    const stores = await marketStub("vm-rm").fetch(new Request("http://do/stores"));
    const list = (await readJson(stores)).stores as Array<{ id: string; shopItems: string[] }>;
    expect(list.length).toBe(2);
    expect(list.find((store) => store.id === "vm-rm-store-1")?.shopItems).toEqual(["Peppers"]);
    expect(list.find((store) => store.id === "vm-rm-store-2")?.shopItems).toEqual(["Rice"]);

    // Removing an item nobody lists is a no-op with no affected stores.
    const noop = await moderate("vm-rm", { action: "remove", item: "Plantain" });
    expect(noop.status).toBe(200);
    const noopBody = await readJson(noop);
    expect(noopBody.vocabulary).toEqual(["Peppers", "Rice"]);
    expect(noopBody.affectedStores).toEqual([]);
  });

  it("rename rewrites the item in place and dedupes when the target is already listed", async () => {
    await registerStore("vm-mv", "vm-mv-store-1", "Amina's Fresh Store", ["Tomatoes", "Peppers"]);
    await registerStore("vm-mv", "vm-mv-store-2", "Chidi's Grains", ["tomatoe", "Rice"]);

    // Dedupe: Peppers → Tomatoes collapses store 1's list.
    const dedupe = await moderate("vm-mv", { action: "rename", from: "Peppers", to: "Tomatoes" });
    expect(dedupe.status).toBe(200);
    const dedupeBody = await readJson(dedupe);
    expect((dedupeBody.affectedStores as AffectedStore[]).map((store) => store.id)).toEqual(["vm-mv-store-1"]);
    const stores = await marketStub("vm-mv").fetch(new Request("http://do/stores"));
    const list = (await readJson(stores)).stores as Array<{ id: string; shopItems: string[] }>;
    expect(list.find((store) => store.id === "vm-mv-store-1")?.shopItems).toEqual(["Tomatoes"]);

    // Case-insensitive match, canonical casing from `to`.
    const fix = await moderate("vm-mv", { action: "rename", from: "TOMATOE", to: "Tomatoes" });
    expect(fix.status).toBe(200);
    expect(await vocabulary("vm-mv")).toEqual(["Rice", "Tomatoes"]);
    const after = await marketStub("vm-mv").fetch(new Request("http://do/stores"));
    const afterList = (await readJson(after)).stores as Array<{ id: string; shopItems: string[] }>;
    expect(afterList.find((store) => store.id === "vm-mv-store-2")?.shopItems).toEqual(["Tomatoes", "Rice"]);
  });

  it("400s on invalid bodies", async () => {
    const cases: unknown[] = [
      { action: "remove", item: "" },
      { action: "remove", item: "   " },
      { action: "remove", item: "x".repeat(65) },
      { action: "rename", from: "Tomatoes", to: "Tomatoes" },
      { action: "rename", from: "", to: "Tomatoes" },
      { action: "explode", item: "Tomatoes" },
      { item: "Tomatoes" },
      "not-an-object",
    ];
    for (const body of cases) {
      const response = await moderate("vm-bad", body);
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toBe("invalid-body");
    }
  });
});

describe("ops vocabulary API", () => {
  it("serves the per-store breakdown and forwards moderation writes", async () => {
    await joinMarket("Vm Ops", "participant-vm-ops");
    await registerStore("Vm Ops", "vm-ops-store-1", "Amina's Fresh Store", ["Tomatoes", "Peppers"]);
    await registerStore("Vm Ops", "vm-ops-store-2", "Chidi's Grains", ["Rice", "peppers"]);

    const breakdown = await SELF.fetch(new Request(`${BASE}/ops/api/markets/Vm%20Ops/vocabulary`));
    expect(breakdown.status).toBe(200);
    const detail = await readJson(breakdown);
    expect(detail.market).toBe("Vm Ops");
    expect(detail.vocabulary).toEqual(["Tomatoes", "Peppers", "Rice", "peppers"].sort((a, b) => a.localeCompare(b)));
    const stores = detail.stores as Array<{ id: string; name: string; shopItems: string[] }>;
    expect(stores.find((store) => store.id === "vm-ops-store-2")?.shopItems).toEqual(["Rice", "peppers"]);

    const renamed = await postJson("/ops/api/markets/Vm%20Ops/vocabulary", {
      action: "rename",
      from: "peppers",
      to: "Peppers",
    });
    expect(renamed.status).toBe(200);
    const renamedBody = await readJson(renamed);
    expect(renamedBody.vocabulary).toEqual(["Peppers", "Rice", "Tomatoes"]);
    expect((renamedBody.affectedStores as AffectedStore[]).map((store) => store.id)).toEqual(["vm-ops-store-2"]);

    const removed = await postJson("/ops/api/markets/Vm%20Ops/vocabulary", { action: "remove", item: "rice" });
    expect(removed.status).toBe(200);
    expect((await readJson(removed)).vocabulary).toEqual(["Peppers", "Tomatoes"]);
  });

  it("400s invalid bodies and 404s unknown markets", async () => {
    const bad = await postJson("/ops/api/markets/Vm%20Ops/vocabulary", { action: "rename", from: "X", to: "X" });
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).error).toBe("invalid-body");

    const get404 = await SELF.fetch(new Request(`${BASE}/ops/api/markets/Nowhere%20Known/vocabulary`));
    expect(get404.status).toBe(404);
    expect((await readJson(get404)).error).toBe("unknown-market");

    const post404 = await postJson("/ops/api/markets/Nowhere%20Known/vocabulary", { action: "remove", item: "Rice" });
    expect(post404.status).toBe(404);
    expect((await readJson(post404)).error).toBe("unknown-market");
  });

  it("403s without the ops token when OPS_TOKEN is set", async () => {
    const app = createApp();
    const env = withOpsToken("secret");

    const refused = await app.fetch(
      new Request(`${BASE}/ops/api/markets/Balogun/vocabulary`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "remove", item: "Tomatoes" }),
      }),
      env,
    );
    expect(refused.status).toBe(403);

    const refusedRead = await app.fetch(new Request(`${BASE}/ops/api/markets/Balogun/vocabulary`), env);
    expect(refusedRead.status).toBe(403);

    const admitted = await app.fetch(
      new Request(`${BASE}/ops/api/markets/Balogun/vocabulary`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ops-token": "secret" },
        body: JSON.stringify({ action: "remove", item: "No Such Item" }),
      }),
      env,
    );
    expect(admitted.status).toBe(200);
    expect((await readJson(admitted)).affectedStores).toEqual([]);
  });
});
