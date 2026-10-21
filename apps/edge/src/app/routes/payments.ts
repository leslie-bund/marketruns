import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../../config/env.js";
import { errorResponse } from "../../do/runtime/index.js";
import { correlationHeaders } from "../middleware/request-id.js";

/**
 * /payments/* proxy → the payments worker (apps/payments), which owns charge
 * confirmation/holds and payout accounts in Postgres (ADR-0011: the edge
 * never touches the database). Same posture as the /auth proxy and the ops
 * console's archive/payments proxies (OPS_ARCHIVE_URL, and PAYMENTS_URL for
 * /ops/api/admin/payments): 503 payments-unavailable when the service is down
 * or unconfigured; upstream bodies pass through untouched — 409
 * amount-mismatch / 422 account-unresolvable etc. are the payments worker's
 * own wire shapes, not proxy errors.
 *
 * Client traffic is edge-first (one base URL for the app); the worker itself
 * stays trusted-internal. The env field is already declared on Env
 * (config/env.ts) for the ops console proxy — this route reuses it.
 */
const DEFAULT_PAYMENTS_URL = "http://localhost:8790";

export function paymentsRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.all("/*", (c) => proxyPayments(c));

  return app;
}

/**
 * /webhooks/* proxy → the payments worker's provider-webhook routes
 * (POST /webhooks/transfers, /webhooks/charges). Mounted separately from
 * /payments/* so provider servers can reach the worker through the ONE edge
 * tunnel — no second tunnel to :8790 for webhook delivery.
 *
 * The edge is a DUMB PIPE here: webhook signature verification stays at the
 * payments worker, which compares the provider's `verif-hash` header against
 * its configured secret (apps/payments/src/flutterwave/webhook.ts). To keep
 * that check intact the proxy forwards the inbound headers VERBATIM (minus
 * host/content-length) rather than rebuilding them the way the client proxy
 * does — dropping `verif-hash` would make every authentic webhook 401.
 *
 * These are server-to-server POSTs with no participant headers and no Bearer
 * session: the global middleware tolerate that by construction (requestId()
 * generates a correlation id when none is supplied; participant() falls
 * through to anonymous). No route-level guard is added — the upstream's hash
 * check is the auth.
 */
export function webhooksRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.all("/*", (c) => proxyPayments(c, { forwardInboundHeaders: true }));

  return app;
}

/** Inbound headers safe to forward verbatim to an upstream on a different host. */
function forwardableHeaders(inbound: Headers): Headers {
  const headers = new Headers(inbound);
  headers.delete("host");
  headers.delete("content-length"); // the body is re-read into an ArrayBuffer
  return headers;
}

async function proxyPayments(
  c: Context<{ Bindings: Env }>,
  options?: { forwardInboundHeaders?: boolean },
): Promise<Response> {
  const base = c.env.PAYMENTS_URL ?? DEFAULT_PAYMENTS_URL;
  const url = new URL(c.req.url);
  const target = new URL(url.pathname + url.search, base);
  let upstream: Response;
  const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
  const headers = options?.forwardInboundHeaders
    ? correlationHeaders(c, forwardableHeaders(c.req.raw.headers))
    : correlationHeaders(c, { "content-type": c.req.header("content-type") ?? "application/json" });
  try {
    upstream = await fetch(target, {
      method: c.req.method,
      headers,
      body: hasBody ? await c.req.raw.clone().arrayBuffer() : null,
    });
  } catch {
    return errorResponse(503, "payments-unavailable", `payments service at ${base} did not respond`);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "x-request-id": upstream.headers.get("x-request-id") ?? c.get("requestId"),
    },
  });
}
