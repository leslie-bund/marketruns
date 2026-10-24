import { z } from "zod";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { Env } from "../config/env.js";
import { errorResponse, jsonResponse } from "../do/runtime/index.js";
import { OpsSettleRequestSchema } from "../do/schemas.js";
import { fetchInternal } from "../do/transport.js";
import { cartIdForBuyer, runIdForCart } from "../config/ids.js";
import { correlationHeaders } from "../app/middleware/request-id.js";
import { OPS_CONSOLE_HTML } from "./html.js";
import { archiveAdminRoutes } from "./archive-proxy.js";
import { identityAdminRoutes } from "./identity-admin.js";
import { managementRoutes } from "./management.js";
import { requireOpsRole } from "./auth.js";
import { auditOps, listOpsAudit } from "./audit.js";
import { OPS_LOGIN_HTML } from "./login.js";
import { telemetryRoutes } from "./telemetry.js";
import { marketsAdminRoutes } from "./markets-admin.js";
import { databaseConfigured } from "./db.js";

/**
 * Minimal ops console (ADR-0013), mounted at /ops. A single embedded HTML
 * page plus a small JSON API. The ONLY adjustment it exposes is the
 * settlement function — ops can pick a mode and dispute evidence shape,
 * never move money directly (ADR-0007).
 *
 * Auth: every /ops/api/* route runs behind the `ops` role guard — in dev
 * the guard admits a local operator when OPS_TOKEN is unset; deployed, the
 * shared token is required (ADR-0015). The HTML page itself follows the same
 * rule when OPS_TOKEN is set, accepting the token as the `x-ops-token`
 * header OR a `?token=` query param so a browser can open it; API fetches
 * from the page always authenticate with the header.
 */
export function opsConsole(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/login", (c) => new Response(OPS_LOGIN_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }));
  app.get("/", (c) => {
    const identity = c.get("opsIdentity");
    if (identity?.mustChangePassword) return c.redirect("/ops/login", 302);
    return new Response(OPS_CONSOLE_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  });
  app.get("/api/session", (c) => c.json({ operator: c.get("opsIdentity") }));
  app.get("/api/audit", listOpsAudit);

  app.get("/api/overview", async (c) => {
    const market = c.req.query("market") ?? "Balogun";
    if (!market) return errorResponse(400, "invalid-query", "bad market");
    // Carts/runs are per buyer (cart:<market>:<buyerId>): pass ?buyerId= to
    // inspect a specific buyer's cart and run; without it the legacy shared
    // derivation is tried (null on a per-buyer deployment).
    return opsOverview(c.env, market, c.req.query("buyerId"), c.get("requestId"));
  });

  app.get("/api/runs/:runId", async (c) => {
    const runId = decodeURIComponent(c.req.param("runId"));
    const stub = c.env.RUN_DO.get(c.env.RUN_DO.idFromName(runId));
    // The RunDO's /ops projection: the wire run PLUS the live dispute block
    // (reason, raiser, merged evidence refs) — ops-only, since clients never
    // enumerate dispute evidence refs (ADR-0019). This is the evidence review
    // surface for the settle control below.
    const response = await stub.fetch(new Request("http://do/ops", { headers: correlationHeaders(c) }));
    if (response.status === 404) return jsonResponse({ run: null });
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
  });

  app.post("/api/runs/:runId/settle", requireOpsRole("admin"), async (c) => {
    const runId = decodeURIComponent(c.req.param("runId"));
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return errorResponse(400, "invalid-body", "request body is not valid JSON");
    }
    const parsed = OpsSettleRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return errorResponse(400, "invalid-body", "request body failed ops-settle validation", { issues: parsed.error.issues });
    }
    const stub = c.env.RUN_DO.get(c.env.RUN_DO.idFromName(runId));
    const response = await stub.fetch(
      new Request("http://do/ops/settle", {
        method: "POST",
        headers: correlationHeaders(c, { "content-type": "application/json" }),
        body: JSON.stringify(parsed.data),
      }),
    );
    if (response.ok) await auditOps(c, { action: "run.settle", entityType: "run", entityId: runId, summary: `Applied ${parsed.data.mode} settlement decision to ${runId}`, metadata: { mode: parsed.data.mode, reason: parsed.data.reason ?? null } });
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
  });

  app.post("/api/admin/payments/:dispatchId/replay", requireOpsRole("admin"), async (c) => {
    const id = decodeURIComponent(c.req.param("dispatchId"));
    const base = c.env.PAYMENTS_URL ?? "http://localhost:8790";
    const response = await fetch(new URL(`/dispatches/${encodeURIComponent(id)}/replay`, base), { method: "POST", headers: correlationHeaders(c) }).catch(() => null);
    if (!response) return errorResponse(503, "payments-unavailable", "payments service did not respond");
    if (response.ok) await auditOps(c, { action: "payment-dispatch.replay", entityType: "payment-dispatch", entityId: id, summary: `Replayed failed dispatch ${id} through the existing dispatcher` });
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
  });

  app.get("/api/reputation", async (c) => {
    if (!c.env.OPS_ARCHIVE_URL) {
      return errorResponse(503, "archive-unavailable", "OPS_ARCHIVE_URL is not configured on the edge worker");
    }
    const target = new URL("/reputation", c.env.OPS_ARCHIVE_URL);
    target.search = new URL(c.req.url).search;
    try {
      const upstream = await fetch(target, { headers: correlationHeaders(c) });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "content-type": "application/json",
          "x-request-id": upstream.headers.get("x-request-id") ?? c.get("requestId"),
        },
      });
    } catch {
      return errorResponse(503, "archive-unavailable", `archive service at ${c.env.OPS_ARCHIVE_URL} did not respond`);
    }
  });

  app.route("/api", archiveAdminRoutes());
  app.route("/api", identityAdminRoutes());

  // Explicit no-database development keeps the original KV/DO market admin
  // usable. Deployed Better Auth always has Postgres and takes the audited
  // management routes below instead.
  const legacyMarkets = marketsAdminRoutes();
  const marketFallback = async (c: Context<{ Bindings: Env }>, next: Next) => {
    if (databaseConfigured(c.env)) return next();
    const url = new URL(c.req.url);
    const api = url.pathname.indexOf("/api/");
    const rebased = `${url.origin}${url.pathname.slice(api + 4)}${url.search}`;
    return legacyMarkets.fetch(new Request(rebased, c.req.raw), c.env);
  };
  app.use("/api/markets", marketFallback);
  app.use("/api/markets/*", marketFallback);
  app.route("/api", managementRoutes());
  app.route("/api", telemetryRoutes());

  // Trailing-slash grace: the console is mounted exactly at /ops, so /ops/
  // (and any other trailing-slash variant) used to fall through to the app
  // 404. Redirect to the canonical slash-less path instead.
  app.get("*", (c) => {
    const url = new URL(c.req.url);
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      return c.redirect(url.pathname.replace(/\/+$/, "") + url.search, 308);
    }
    return errorResponse(404, "not-found", `no route: ${c.req.method} ${url.pathname}`);
  });

  return app;
}


async function opsOverview(env: Env, market: string, buyerId?: string, requestId?: string): Promise<Response> {
  const correlation = requestId !== undefined ? { headers: { "x-request-id": requestId } } : {};
  const marketStub = env.MARKET_DO.get(env.MARKET_DO.idFromName(market));
  // No buyer picked: fall back to the anonymous shared cart — the legacy
  // `cart:<market>` shape is written by nothing since ADR-0018.
  const cartId = cartIdForBuyer(market, buyerId ?? "buyer:anonymous");
  const cartStub = env.CART_DO.get(env.CART_DO.idFromName(cartId));
  const [config, intents, cart] = await Promise.all([
    fetchInternal(marketStub, new Request("http://do/config", correlation), z.object({}).passthrough()),
    fetchInternal(marketStub, new Request("http://do/intents", correlation), z.object({ intents: z.array(z.unknown()) })),
    cartStub.fetch(new Request("http://do/", correlation)).then(async (response) => {
      if (response.status === 404) return null;
      return response.json();
    }),
  ]);
  if (config instanceof Response) return config;
  if (intents instanceof Response) return intents;
  const runId = runIdForCart(cartId);
  const runResponse = await env.RUN_DO.get(env.RUN_DO.idFromName(runId)).fetch(new Request("http://do/", correlation));
  const run = runResponse.status === 404 ? null : await runResponse.json();
  return jsonResponse({ market, config, intents: intents.intents, cart, run });
}
