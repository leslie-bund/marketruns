import { fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/config/env.js";
import { createApp } from "../src/app/app.js";
import { archiveAdminRoutes } from "../src/ops-console/archive-proxy.js";
import { bindings, readJson } from "./helpers.js";

const BASE = "http://edge";
const INTERNAL_TOKEN = "ops-recovery-internal-test-token";

function withPaymentsToken(): Env {
  return new Proxy(bindings, {
    get: (target, prop, receiver) =>
      prop === "PAYMENTS_INTERNAL_TOKEN" ? INTERNAL_TOKEN : Reflect.get(target, prop, receiver),
  }) as Env;
}

function withArchiveToken(): Env {
  return new Proxy(bindings, {
    get: (target, prop, receiver) =>
      prop === "ARCHIVE_INTERNAL_TOKEN" ? INTERNAL_TOKEN : Reflect.get(target, prop, receiver),
  }) as Env;
}

const recoveryPayload = {
  items: [
    {
      runId: "run:cart:Balogun:buyer:ada",
      market: "Balogun",
      settlementRecordId: "settlement-1",
      buyerId: "buyer:ada",
      runnerId: "runner:internal",
      issues: [
        {
          kind: "dispatch",
          id: "dispatch-1",
          status: "failed",
          amountKobo: 12_500,
          updatedAt: 1_700_000_000_000,
        },
      ],
      actions: [{ type: "replay-dispatch", targetId: "dispatch-1" }],
    },
  ],
  total: 1,
};

describe("ops admin recovery proxy", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterAll(() => {
    fetchMock.deactivate();
  });

  it("forwards the market query with trusted service auth and correlation, then validates the list", async () => {
    let seenHeaders: Record<string, string> | undefined;
    fetchMock
      .get("http://localhost:8790")
      .intercept({ path: "/recovery?market=Balogun&limit=20&offset=0", method: "GET" })
      .reply(200, (opts) => {
        seenHeaders = opts.headers as Record<string, string>;
        return JSON.stringify(recoveryPayload);
      }, { headers: { "content-type": "application/json" } });

    const response = await createApp().fetch(new Request(
      `${BASE}/ops/api/admin/recovery?market=Balogun&limit=20&offset=0`,
      { headers: { "x-request-id": "ops-recovery-read", "x-payments-internal": "client-forged-token" } },
    ), withPaymentsToken());

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual(recoveryPayload);
    expect(seenHeaders?.["x-payments-internal"]).toBe(INTERNAL_TOKEN);
    expect(seenHeaders?.["x-request-id"]).toBe("ops-recovery-read");
  });

  it("fails closed when payments returns an invalid recovery item", async () => {
    fetchMock
      .get("http://localhost:8790")
      .intercept({ path: "/recovery?market=Balogun", method: "GET" })
      .reply(200, JSON.stringify({ items: [{ nope: true }], total: 1, limit: 20, offset: 0 }), {
        headers: { "content-type": "application/json" },
      });

    const response = await createApp().fetch(
      new Request(`${BASE}/ops/api/admin/recovery?market=Balogun`),
      withPaymentsToken(),
    );

    expect(response.status).toBe(502);
    expect((await readJson(response)).error).toBe("bad-payments-response");
  });

  it("fails closed before forwarding when payments service auth is not configured", async () => {
    const env = new Proxy(bindings, {
      get: (target, prop, receiver) =>
        prop === "PAYMENTS_INTERNAL_TOKEN" || prop === "ALLOW_HEADER_AUTH"
          ? undefined
          : Reflect.get(target, prop, receiver),
    }) as Env;

    const response = await createApp().fetch(
      new Request(`${BASE}/ops/api/admin/recovery?market=Balogun`),
      env,
    );

    expect(response.status).toBe(503);
    expect((await readJson(response)).error).toBe("payments-auth-unconfigured");
  });

  it("rejects non-admin operators before reaching the payments proxy", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", async (c, next) => {
      c.set("opsIdentity", {
        id: "ops:operator",
        email: "operator@example.test",
        name: "Operator",
        role: "operator",
        mustChangePassword: false,
      });
      await next();
    });
    app.route("/ops/api", archiveAdminRoutes());

    const response = await app.fetch(
      new Request(`${BASE}/ops/api/admin/recovery?market=Balogun`),
      withPaymentsToken(),
    );

    expect(response.status).toBe(403);
    expect((await readJson(response)).error).toBe("forbidden");
  });

  it("lets only admins hold retained media and forwards the audited actor", async () => {
    const media = {
      id: "product:1:image", subjectType: "product", subjectId: "1",
      captureRef: "r2://archive/products/captures/1.jpg", objectKey: "products/captures/1.jpg",
      mediaKind: "image", ownerId: "seller:1", cartId: null, runId: null, status: "held",
      retiredAt: 1_700_000_000_000, deleteAfter: 1_700_000_100_000,
      holdReason: "incident review", heldBy: "admin@example.test", heldAt: 1_700_000_000_000,
      lastError: null, deletedAt: null,
    };
    let requestBody = "";
    let seenHeaders: Record<string, string> | undefined;
    fetchMock.get("http://localhost:8788").intercept({
      path: "/admin/retained-media/product%3A1%3Aimage/hold", method: "POST",
    }).reply(200, async (opts) => {
      requestBody = String(opts.body);
      seenHeaders = opts.headers as Record<string, string>;
      return JSON.stringify({ media });
    }, { headers: { "content-type": "application/json" } });

    const app = new Hono<{ Bindings: Env }>();
    app.use("*", async (c, next) => {
      c.set("opsIdentity", { id: "ops:admin", email: "admin@example.test", name: "Admin", role: "admin", mustChangePassword: false });
      await next();
    });
    app.route("/ops/api", archiveAdminRoutes());
    const response = await app.fetch(new Request(`${BASE}/ops/api/admin/retained-media/product%3A1%3Aimage/hold`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "incident review" }),
    }), withArchiveToken());
    expect(response.status).toBe(200);
    expect(JSON.parse(requestBody)).toEqual({ reason: "incident review", heldBy: "admin@example.test" });
    expect(seenHeaders?.["x-archive-internal"]).toBe(INTERNAL_TOKEN);

    const deniedApp = new Hono<{ Bindings: Env }>();
    deniedApp.use("*", async (c, next) => {
      c.set("opsIdentity", { id: "ops:operator", email: "operator@example.test", name: "Operator", role: "operator", mustChangePassword: false });
      await next();
    });
    deniedApp.route("/ops/api", archiveAdminRoutes());
    const denied = await deniedApp.fetch(new Request(`${BASE}/ops/api/admin/retained-media/product%3A1%3Aimage/hold`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "incident review" }),
    }), withPaymentsToken());
    expect(denied.status).toBe(403);
  });
});
