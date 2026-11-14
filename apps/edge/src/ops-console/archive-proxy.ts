import { z } from "zod";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  AdminListSchema,
  AdminRunEntrySchema,
  ArchiveQueueResponseSchema,
  DisputeViewSchema,
  LedgerViewSchema,
  OpsHealthSchema,
  PaymentDispatchViewSchema,
  PaymentHoldViewSchema,
  PaymentRecoveryItemSchema,
  PaymentRefundViewSchema,
  RetainedMediaViewSchema,
  SettlementViewSchema,
} from "@market-runs/proto";
import type { Env } from "../config/env.js";
import { errorResponse } from "../do/runtime/index.js";
import { correlationHeaders } from "../app/middleware/request-id.js";
import { paymentsAuthConfigured, paymentsServiceHeaders } from "../config/payments-auth.js";
import { requireOpsRole } from "./auth.js";
import { auditOps } from "./audit.js";

/** Dev default for the payments worker (wrangler dev of apps/payments); override with PAYMENTS_URL. */
const PAYMENTS_URL_DEFAULT = "http://localhost:8790";

/** Payments returns compact {items,total}; validate the items through the shared admin-list schema. */
const PaymentRecoveryAdminListSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const envelope = raw as { items?: unknown; limit?: unknown; offset?: unknown };
  if (!Array.isArray(envelope.items)) return raw;
  return {
    ...envelope,
    limit: envelope.limit ?? Math.max(1, envelope.items.length),
    offset: envelope.offset ?? 0,
  };
}, AdminListSchema(PaymentRecoveryItemSchema)).transform(({ items, total }) => ({ items, total }));

/**
 * Response headers for a proxied call: JSON plus the upstream's correlation id
 * when it echoed one (the edge's own id otherwise — they are identical when
 * the upstream honors the forwarded x-request-id).
 */
function proxiedHeaders(c: Context<{ Bindings: Env }>, upstream: Response): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-request-id": upstream.headers.get("x-request-id") ?? c.get("requestId"),
  };
}

/**
 * Ops console → archive service proxies for the admin oversight dashboard
 * (read models over Postgres, ADR-0011). Mounted at /ops/api, behind the
 * requireOps guard like every console API route.
 *
 * Failure contract (same as /ops/api/reputation):
 *   503 archive-unavailable — OPS_ARCHIVE_URL unset, or the archive did not respond;
 *   502 bad-archive-response — a 2xx body failed proto-schema validation (fail closed).
 * Non-2xx upstream responses (e.g. a 400 invalid-query) pass through untouched.
 */
export function archiveAdminRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/admin/runs", (c) => proxyArchive(c, "/admin/runs", AdminListSchema(AdminRunEntrySchema)));
  app.get("/admin/disputes", (c) => proxyArchive(c, "/admin/disputes", AdminListSchema(DisputeViewSchema)));
  app.get("/admin/settlements", (c) => proxyArchive(c, "/admin/settlements", AdminListSchema(SettlementViewSchema)));
  app.get("/admin/ledger", (c) => proxyArchive(c, "/admin/ledger", AdminListSchema(LedgerViewSchema)));
  app.get("/admin/ops-health", (c) => proxyArchive(c, "/admin/ops-health", OpsHealthSchema));
  app.get("/admin/archive-queue", (c) => proxyArchive(c, "/admin/archive-queue", ArchiveQueueResponseSchema));
  app.get("/admin/retained-media", (c) => proxyArchive(c, "/admin/retained-media", AdminListSchema(RetainedMediaViewSchema)));
  app.post("/admin/retained-media/:id/hold", requireOpsRole("admin"), (c) => retainedMediaHold(c, "hold"));
  app.post("/admin/retained-media/:id/release", requireOpsRole("admin"), (c) => retainedMediaHold(c, "release"));
  // Second upstream: the payments worker owns its own dispatch table and
  // serves /dispatches itself — the console just proxies (PAYMENTS_URL, dev
  // default above). Same failure contract, payments-* error codes.
  app.get("/admin/payments", (c) => proxyPayments(c, "/dispatches", AdminListSchema(PaymentDispatchViewSchema)));
  // Recovery is an operator action queue, not a read-only oversight list.
  app.get("/admin/recovery", requireOpsRole("admin"), (c) =>
    proxyPayments(c, "/recovery", PaymentRecoveryAdminListSchema));
  // Collection side: holds + refunds (charge verification, checkout gating,
  // the buyer-refund rail) — same proxy contract as /admin/payments.
  app.get("/admin/holds", (c) => proxyPayments(c, "/payments/holds", AdminListSchema(PaymentHoldViewSchema)));
  app.get("/admin/refunds", (c) => proxyPayments(c, "/payments/refunds", AdminListSchema(PaymentRefundViewSchema)));

  return app;
}

async function retainedMediaHold(c: Context<{ Bindings: Env }>, action: "hold" | "release"): Promise<Response> {
  const id = decodeURIComponent(c.req.param("id") ?? "");
  const input = action === "hold"
    ? z.object({ reason: z.string().trim().min(1).max(500) }).safeParse(await c.req.json().catch(() => null))
    : null;
  if (input && !input.success) return errorResponse(400, "invalid-body", "a hold reason is required");
  const actor = c.get("opsIdentity");
  const response = await proxyArchive(c, `/admin/retained-media/${encodeURIComponent(id)}/${action}`, z.object({ media: RetainedMediaViewSchema }), {
    body: action === "hold" && input ? { reason: input.data.reason, heldBy: actor.email } : {},
  });
  if (response.ok) {
    await auditOps(c, {
      action: `retained-media.${action}`,
      entityType: "retained-media",
      entityId: id,
      summary: `${action === "hold" ? "Held" : "Released"} retired media ${id}`,
      metadata: action === "hold" && input ? { reason: input.data.reason } : {},
    });
  }
  return response;
}

/** Forward the request (query string included) to the payments worker and validate its 2xx body. */
async function proxyPayments<S extends z.ZodTypeAny>(
  c: Context<{ Bindings: Env }>,
  path: string,
  schema: S,
): Promise<Response> {
  const base = c.env.PAYMENTS_URL ?? PAYMENTS_URL_DEFAULT;
  if (!paymentsAuthConfigured(c.env)) {
    return errorResponse(503, "payments-auth-unconfigured", "PAYMENTS_INTERNAL_TOKEN is required");
  }
  const target = new URL(path, base);
  target.search = new URL(c.req.url).search;
  let upstream: Response;
  try {
    upstream = await (c.env.PAYMENTS_SERVICE ?? { fetch }).fetch(target, { headers: paymentsServiceHeaders(c.env, correlationHeaders(c)) });
  } catch {
    return errorResponse(503, "payments-unavailable", `payments service at ${base} did not respond`);
  }
  if (!upstream.ok) {
    return new Response(upstream.body, { status: upstream.status, headers: proxiedHeaders(c, upstream) });
  }
  let raw: unknown;
  try {
    raw = await upstream.json();
  } catch {
    return errorResponse(502, "bad-payments-response", `payments ${path} returned non-JSON`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(502, "bad-payments-response", `payments ${path} response failed validation`, {
      issues: parsed.error.issues,
    });
  }
  return new Response(JSON.stringify(parsed.data), { headers: proxiedHeaders(c, upstream) });
}

/** Forward the request (query string included) to the archive and validate its 2xx body. */
async function proxyArchive<S extends z.ZodTypeAny>(
  c: Context<{ Bindings: Env }>,
  path: string,
  schema: S,
  options?: { body: unknown },
): Promise<Response> {
  if (!c.env.OPS_ARCHIVE_URL) {
    return errorResponse(503, "archive-unavailable", "OPS_ARCHIVE_URL is not configured on the edge worker");
  }
  const target = new URL(path, c.env.OPS_ARCHIVE_URL);
  target.search = new URL(c.req.url).search;
  let upstream: Response;
  try {
    upstream = await (c.env.ARCHIVE_SERVICE ?? { fetch }).fetch(target, {
      method: options ? "POST" : "GET",
      headers: correlationHeaders(c, {
        ...(options ? { "content-type": "application/json" } : {}),
        ...(c.env.ARCHIVE_INTERNAL_TOKEN ? { "x-archive-internal": c.env.ARCHIVE_INTERNAL_TOKEN } : {}),
      }),
      ...(options ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    return errorResponse(503, "archive-unavailable", `archive service at ${c.env.OPS_ARCHIVE_URL} did not respond`);
  }
  if (!upstream.ok) {
    // Upstream refusals (invalid-query etc.) are already in the wire error shape.
    return new Response(upstream.body, { status: upstream.status, headers: proxiedHeaders(c, upstream) });
  }
  let raw: unknown;
  try {
    raw = await upstream.json();
  } catch {
    return errorResponse(502, "bad-archive-response", `archive ${path} returned non-JSON`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(502, "bad-archive-response", `archive ${path} response failed validation`, {
      issues: parsed.error.issues,
    });
  }
  return new Response(JSON.stringify(parsed.data), { headers: proxiedHeaders(c, upstream) });
}
