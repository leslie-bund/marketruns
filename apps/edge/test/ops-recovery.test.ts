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
});

describe("ops Recovery tab", () => {
  it("renders grouped run, market, issue, and action values through escaping helpers", async () => {
    const page = await createApp().fetch(new Request(`${BASE}/ops`), bindings);
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(html).toContain('{ id: "recovery", label: "Recovery" }');
    expect(html).toContain("renderRecoveryItem");
    expect(html).toContain("esc(x.runId)");
    expect(html).toContain("esc(x.market)");
    expect(html).toContain("esc(x.settlementRecordId)");
    expect(html).toContain("esc(x.buyerId)");
    expect(html).toContain("esc(x.runnerId)");
    expect(html).toContain("esc(issue.kind)");
    expect(html).toContain("statusPill(issue.status)");
    expect(html).toContain("esc(issue.id)");
    expect(html).toContain("esc(money(issue.amountKobo))");
    expect(html).toContain("esc(timeAgo(issue.updatedAt))");
    expect(html).toContain("esc(action.targetId)");
    expect(html).toContain("No settlements need attention");
  });

  it("maps every supplied action to the existing admin endpoint with confirmation, errors, and Recovery reload", async () => {
    const page = await createApp().fetch(new Request(`${BASE}/ops`), bindings);
    const html = await page.text();

    expect(page.status).toBe(200);
    for (const action of ["replay-dispatch", "sync-dispatch", "resolve-refund", "redrive-settlement"]) {
      expect(html).toContain(action);
    }
    expect(html).toContain('"/ops/api/admin/payments/"');
    expect(html).toContain('"/replay"');
    expect(html).toContain('"/sync"');
    expect(html).toContain('"/ops/api/admin/refunds/"');
    expect(html).toContain('"/resolution"');
    expect(html).toContain('"/ops/api/admin/settlements/"');
    expect(html).toContain('"/redrive"');
    expect(html).toContain("window.confirm");
    expect(html).toContain('resolveRefund(t.getAttribute("data-id"), t, "recovery")');
    expect(html).toContain('loadTab("recovery")');
    expect(html).toContain("recovery action failed");
  });
});
