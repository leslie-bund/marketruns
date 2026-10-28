import { SELF, fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RunStartedSchema } from "@market-runs/proto";
import type { Env } from "../src/env.js";
import { createApp } from "../src/app/app.js";
import { defaultMarketConfig } from "../src/do/schemas.js";
import {
  acceptProduct,
  bindings,
  checkout,
  offerProduct,
  postIntent,
  readJson,
} from "./helpers.js";

const BASE = "http://edge";

// The ops console API is exercised through the real worker; the guard tests
// additionally drive createApp()/marketsRoute() with an OPS_TOKEN-carrying
// env so the deployed-enforcement branch is reachable.
function SELF_FETCH(path: string, init: RequestInit): Promise<Response> {
  return SELF.fetch(new Request(`${BASE}${path}`, init));
}

function postJson(path: string, body: unknown, headers?: Headers): Promise<Response> {
  const all = new Headers(headers);
  all.set("content-type", "application/json");
  return SELF_FETCH(path, { method: "POST", headers: all, body: JSON.stringify(body) });
}

/** An env that behaves like the test bindings but with OPS_TOKEN set. */
function withOpsToken(token: string): Env {
  return new Proxy(bindings, {
    get: (target, prop, receiver) => (prop === "OPS_TOKEN" ? token : Reflect.get(target, prop, receiver)),
  }) as Env;
}

describe("run.started archive emission", () => {
  it("checkout announces the live run on the archive queue", async () => {
    const sendSpy = vi.spyOn(bindings.ARCHIVE_QUEUE, "send");

    expect((await postIntent("rs-intent-1", "rs")).status).toBe(200);
    expect((await offerProduct("rs-product-1", "rs-intent-1", "rs")).status).toBe(200);
    expect((await acceptProduct("rs-product-1")).status).toBe(200);
    const accepted = await checkout("cart:rs:buyer:anonymous");
    expect(accepted.status).toBe(200);

    const started = sendSpy.mock.calls
      .map(([body]) => RunStartedSchema.safeParse(typeof body === "string" ? JSON.parse(body) : body))
      .find((parsed) => parsed.success);
    expect(started?.success).toBe(true);
    if (started?.success) {
      expect(started.data).toMatchObject({
        type: "run.started",
        runId: "run:cart:rs:buyer:anonymous",
        market: "rs",
        status: "assigned",
        runnerId: "runner:internal",
        buyerId: "buyer:anonymous",
        stopCount: 1,
        // The cart's stores ride the announcement (seller run discovery).
        storeIds: ["Amina's Fresh Store"],
      });
      expect(started.data.startedAt).toBeGreaterThan(0);
    }
    sendSpy.mockRestore();
  });
});

describe("ops admin archive proxies", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterAll(() => {
    fetchMock.deactivate();
  });

  it("503s clearly when the archive does not respond", async () => {
    // No mock registered for this path: outbound fetch is refused → the same
    // archive-unavailable contract as an unconfigured OPS_ARCHIVE_URL.
    const response = await SELF_FETCH("/ops/api/admin/runs", {});
    expect(response.status).toBe(503);
    expect((await readJson(response)).error).toBe("archive-unavailable");
  });

  it("passes query params through and returns validated lists", async () => {
    const payload = {
      items: [
        {
          kind: "live",
          runId: "run:cart:rs:buyer:anonymous",
          market: "rs",
          status: "assigned",
          runnerId: "runner:internal",
          buyerId: "buyer:anonymous",
          startedAt: 1_700_000_000_000,
          retiredAt: null,
          stopCount: 1,
          storeIds: ["Amina's Fresh Store"],
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    };
    const pool = fetchMock.get("http://localhost:8788");
    const intercept = pool
      .intercept({ path: "/admin/runs?market=rs&status=assigned&limit=10&offset=0" })
      .reply(200, JSON.stringify(payload), { headers: { "content-type": "application/json" } });

    const response = await SELF_FETCH("/ops/api/admin/runs?market=rs&status=assigned&limit=10&offset=0", {});
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.total).toBe(1);
    expect((body.items as Array<{ runId: string }>)[0]?.runId).toBe("run:cart:rs:buyer:anonymous");
    expect(intercept).toBeDefined();
  });

  it("fails closed with 502 when the archive returns a shape mismatch", async () => {
    fetchMock
      .get("http://localhost:8788")
      .intercept({ path: "/admin/disputes" })
      .reply(200, JSON.stringify({ items: [{ nope: true }] }), { headers: { "content-type": "application/json" } });

    const response = await SELF_FETCH("/ops/api/admin/disputes", {});
    expect(response.status).toBe(502);
    expect((await readJson(response)).error).toBe("bad-archive-response");
  });

  it("502s on non-JSON and passes upstream refusals through", async () => {
    fetchMock
      .get("http://localhost:8788")
      .intercept({ path: "/admin/ledger" })
      .reply(200, "not json", { headers: { "content-type": "text/plain" } });
    const badJson = await SELF_FETCH("/ops/api/admin/ledger", {});
    expect(badJson.status).toBe(502);

    fetchMock
      .get("http://localhost:8788")
      .intercept({ path: "/admin/ops-health" })
      .reply(400, JSON.stringify({ error: "invalid-query", message: "market query param is required" }), {
        headers: { "content-type": "application/json" },
      });
    const refused = await SELF_FETCH("/ops/api/admin/ops-health", {});
    expect(refused.status).toBe(400);
    expect((await readJson(refused)).error).toBe("invalid-query");
  });

  it("validates ops-health against its proto schema", async () => {
    const gate = { threshold: 1, pass: true };
    fetchMock
      .get("http://localhost:8788")
      .intercept({ path: "/admin/ops-health?market=rs" })
      .reply(
        200,
        JSON.stringify({
          market: "rs",
          consecutiveQualifyingWeeks: 0,
          completedRuns: 0,
          disputeRateBps: 0,
          zeroTouchRateBps: 0,
          repeatBuyers: 0,
          gate: {
            qualifyingWeeks: gate,
            completedRuns: gate,
            disputeRateBps: gate,
            zeroTouchRateBps: gate,
            repeatBuyers: gate,
            pass: false,
          },
          computedAt: 1_700_000_000_000,
        }),
        { headers: { "content-type": "application/json" } },
      );
    const response = await SELF_FETCH("/ops/api/admin/ops-health?market=rs", {});
    expect(response.status).toBe(200);
    expect((await readJson(response)).market).toBe("rs");
  });
});

describe("ops zone admin", () => {
  it("creates a zone, lists it with its config, and rejects duplicates with 409", async () => {
    const config = defaultMarketConfig(Date.now());
    const created = await postJson("/ops/api/markets", { name: "Mz Zone", ...config });
    expect(created.status, await created.clone().text()).toBe(201);
    const createdBody = await readJson(created);
    expect((createdBody.market as { id: string }).id).toBe("Mz Zone");
    expect(createdBody.indexed).toBe(true);

    const duplicate = await postJson("/ops/api/markets", { name: "Mz Zone", ...config });
    expect(duplicate.status).toBe(409);
    expect((await readJson(duplicate)).error).toBe("market-exists");

    // Seed zones count as duplicates too (case-insensitive).
    const seedDupe = await postJson("/ops/api/markets", { name: "balogun", ...config });
    expect(seedDupe.status).toBe(409);

    const listed = await SELF_FETCH("/ops/api/markets", {});
    expect(listed.status).toBe(200);
    const markets = (await readJson(listed)).markets as Array<{ id: string; config: { closeAt: number } | null }>;
    const zone = markets.find((market) => market.id === "Mz Zone");
    expect(zone).toBeDefined();
    expect(zone?.config?.closeAt).toBe(config.closeAt);
    // Seed zones appear with their (default) configs — never a 500.
    expect(markets.some((market) => market.id === "Balogun")).toBe(true);
  });

  it("rejects bad names and bad bodies with 400", async () => {
    const config = defaultMarketConfig(Date.now());
    const badName = await postJson("/ops/api/markets", { name: "bad/zone!", ...config });
    expect(badName.status).toBe(400);
    const badConfig = await postJson("/ops/api/markets", { name: "Mz Other", closeAt: "soon" });
    expect(badConfig.status).toBe(400);
  });

  it("updates a zone's config and 404s unknown zones", async () => {
    const config = { ...defaultMarketConfig(Date.now()), bufferMs: 7 * 60 * 1000 };
    const updated = await postJson("/ops/api/markets/Mz%20Zone/config", config);
    expect(updated.status).toBe(200);
    const body = await readJson(updated);
    expect((body.config as { bufferMs: number }).bufferMs).toBe(7 * 60 * 1000);

    const missing = await postJson("/ops/api/markets/Nowhere%20Known/config", config);
    expect(missing.status).toBe(404);
    expect((await readJson(missing)).error).toBe("unknown-market");
  });
});

describe("market config write guard (edge route layer)", () => {
  it("403s config writes without the ops token when OPS_TOKEN is set", async () => {
    const app = createApp();
    const env = withOpsToken("secret");
    const config = defaultMarketConfig(Date.now());

    const refused = await app.fetch(
      new Request(`${BASE}/markets/guarded/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      }),
      env,
    );
    expect(refused.status).toBe(403);

    const admitted = await app.fetch(
      new Request(`${BASE}/markets/guarded/config`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ops-token": "secret" },
        body: JSON.stringify(config),
      }),
      env,
    );
    expect(admitted.status).toBe(200);

    // Client reads are untouched: GET /config stays open without any token.
    const read = await app.fetch(new Request(`${BASE}/markets/guarded/config`), env);
    expect(read.status).toBe(200);
  });
});

describe("deployed Better Auth routing", () => {
  it("serves only the login page publicly and never admits the legacy token", async () => {
    const app = createApp();
    const env = new Proxy(bindings, {
      get: (target, prop, receiver) => {
        if (prop === "OPS_LOCAL_DEV") return "false";
        if (prop === "OPS_LEGACY_DEV" || prop === "OPS_TOKEN") return prop === "OPS_TOKEN" ? "legacy-secret" : "true";
        if (prop === "OPS_AUTH_SECRET") return "deployed-test-secret-at-least-32-characters";
        if (prop === "DATABASE_URL" || prop === "HYPERDRIVE") return undefined;
        return Reflect.get(target, prop, receiver);
      },
    }) as Env;

    const login = await app.fetch(new Request(`${BASE}/ops/login?token=legacy-secret`), env);
    expect(login.status).toBe(200);
    expect(await login.text()).toContain("Sign in");

    for (const path of ["/ops?token=legacy-secret", "/ops/api/session?token=legacy-secret", "/ops/api/markets?token=legacy-secret"]) {
      const protectedResponse = await app.fetch(new Request(`${BASE}${path}`, { headers: { "x-ops-token": "legacy-secret" } }), env);
      expect(protectedResponse.status).toBe(503);
      expect((await readJson(protectedResponse)).error).toBe("ops-auth-unavailable");
    }
  });
});

describe("ops console page guard", () => {
  it("requires the token for the HTML page when OPS_TOKEN is set", async () => {
    const app = createApp();
    const env = withOpsToken("secret");

    const refused = await app.fetch(new Request(`${BASE}/ops`), env);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("content-type")).toContain("text/html");
    const refusedBody = await refused.text();
    expect(refusedBody).toContain("403");
    expect(refusedBody).not.toContain("Market Runs — Ops Console");

    const viaQuery = await app.fetch(new Request(`${BASE}/ops?token=secret`), env);
    expect(viaQuery.status).toBe(200);
    expect(await viaQuery.text()).toContain("Ops Console");

    const viaHeader = await app.fetch(new Request(`${BASE}/ops`, { headers: { "x-ops-token": "secret" } }), env);
    expect(viaHeader.status).toBe(200);

    const wrong = await app.fetch(new Request(`${BASE}/ops?token=nope`), env);
    expect(wrong.status).toBe(403);
  });

  it("serves the page as today when OPS_TOKEN is unset (dev)", async () => {
    const app = createApp();
    const page = await app.fetch(new Request(`${BASE}/ops`), bindings);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Ops Console");
  });
});
