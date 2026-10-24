import { Hono } from "hono";
import type { Context } from "hono";
import { DeviceResetDecisionRequestSchema, DeviceResetListResponseSchema } from "@market-runs/proto";
import type { Env } from "../config/env.js";
import { errorResponse } from "../do/runtime/index.js";
import { correlationHeaders } from "../app/middleware/request-id.js";
import { requireOpsRole } from "./auth.js";
import { auditOps } from "./audit.js";

/** Dev default for the identity worker (wrangler dev of apps/identity); override with IDENTITY_URL. */
const IDENTITY_URL_DEFAULT = "http://localhost:8789";

/**
 * Ops console → identity service proxies for the device-reset queue
 * (ADR-0022's ops-approved reset). Mounted at /ops/api, behind the
 * requireOps guard like every console API route.
 *
 * Both routes hit the identity worker's requireInternal seam, so when
 * IDENTITY_INTERNAL_TOKEN is set the proxy injects it as
 * `x-identity-internal` — the SAME scoped injection the /auth/* proxy
 * applies (app/routes/auth.ts). Unset is the dev posture: nothing injected,
 * the upstream routes stay open.
 *
 * Failure contract (mirrors the archive proxies):
 *   503 identity-unavailable — the identity service did not respond;
 *   502 bad-identity-response — a 2xx list body failed proto-schema validation (fail closed).
 * Non-2xx upstream responses (e.g. 404 reset-not-found, 409 reset-already-resolved)
 * pass through untouched.
 */
export function identityAdminRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/device-resets", async (c) => {
    const target = new URL("/auth/device-reset", base(c));
    target.search = new URL(c.req.url).search;
    let upstream: Response;
    try {
      upstream = await fetch(target, { headers: internalHeaders(c) });
    } catch {
      return errorResponse(503, "identity-unavailable", `identity service at ${base(c)} did not respond`);
    }
    if (!upstream.ok) {
      return new Response(upstream.body, { status: upstream.status, headers: proxiedHeaders(c, upstream) });
    }
    let raw: unknown;
    try {
      raw = await upstream.json();
    } catch {
      return errorResponse(502, "bad-identity-response", "identity /auth/device-reset returned non-JSON");
    }
    const parsed = DeviceResetListResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return errorResponse(502, "bad-identity-response", "identity /auth/device-reset response failed validation", {
        issues: parsed.error.issues,
      });
    }
    return new Response(JSON.stringify(parsed.data), { headers: proxiedHeaders(c, upstream) });
  });

  app.post("/device-resets/:id/decision", requireOpsRole("operator"), async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return errorResponse(400, "invalid-body", "request body is not valid JSON");
    }
    const parsed = DeviceResetDecisionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return errorResponse(400, "invalid-body", "request body failed device-reset decision validation", {
        issues: parsed.error.issues,
      });
    }
    const target = new URL(`/auth/device-reset/${encodeURIComponent(c.req.param("id"))}/decision`, base(c));
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: "POST",
        headers: internalHeaders(c),
        body: JSON.stringify(parsed.data),
      });
    } catch {
      return errorResponse(503, "identity-unavailable", `identity service at ${base(c)} did not respond`);
    }
    if (upstream.ok) await auditOps(c, { action: `device-reset.${parsed.data.decision}`, entityType: "device-reset", entityId: c.req.param("id"), summary: `${parsed.data.decision} device reset ${c.req.param("id")}` });
    return new Response(upstream.body, { status: upstream.status, headers: proxiedHeaders(c, upstream) });
  });

  return app;
}

function base(c: Context<{ Bindings: Env }>): string {
  return c.env.IDENTITY_URL ?? IDENTITY_URL_DEFAULT;
}

/** Correlation headers plus the scoped internal-token injection (see the header comment). */
function internalHeaders(c: Context<{ Bindings: Env }>): Headers {
  const headers = correlationHeaders(c, { "content-type": "application/json" });
  const token = c.env.IDENTITY_INTERNAL_TOKEN;
  if (token) headers.set("x-identity-internal", token);
  return headers;
}

function proxiedHeaders(c: Context<{ Bindings: Env }>, upstream: Response): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-request-id": upstream.headers.get("x-request-id") ?? c.get("requestId"),
  };
}
