import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../../config/env.js";
import { errorResponse } from "../../do/runtime/index.js";
import { correlationHeaders } from "../middleware/request-id.js";

/**
 * /auth/* proxy → the identity worker (apps/identity), which owns all
 * credential/biometric state in Postgres (ADR-0011: the edge never touches
 * the database). Same posture as the ops console's archive proxies
 * (OPS_ARCHIVE_URL): 503 identity-unavailable when the service is down or
 * unconfigured; upstream bodies pass through untouched — the client holds
 * the proto auth schemas and login failures (401 face-mismatch etc.) are
 * the identity worker's own wire shapes, not proxy errors.
 *
 * When IDENTITY_INTERNAL_TOKEN is set, the proxy injects it as
 * `x-identity-internal` on the identity worker's requireInternal routes
 * ONLY (face enrollment, the device-reset queue read, device-reset
 * decisions — ADR-0022): scoped, so the shared secret never rides unrelated
 * /auth/* routes. Unset is the dev posture — nothing is injected and the
 * upstream routes stay open.
 */

const DEFAULT_IDENTITY_URL = "http://localhost:8789";

export function authRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.all("/*", (c) => proxyIdentity(c));

  return app;
}

/**
 * /callbacks/* proxy → the identity worker's provider-callback route
 * (POST /callbacks/:provider, e.g. Smile ID). Mounted separately from /auth/*
 * so provider servers can reach the worker through the ONE edge tunnel — no
 * second tunnel for identity callbacks.
 *
 * The edge is a DUMB PIPE here: callback signature verification stays at the
 * identity worker (AsyncFaceVerifier.handleCallback reads the raw request —
 * the signature IS the auth). The proxy therefore forwards the inbound
 * headers VERBATIM (minus host/content-length) so that check sees the request
 * exactly as the provider sent it.
 *
 * Server-to-server POSTs with no participant headers: requestId() generates a
 * correlation id and participant() falls through to anonymous, so no
 * route-level guard is needed.
 */
export function callbacksRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.all("/*", (c) => proxyIdentity(c, { forwardInboundHeaders: true }));

  return app;
}

/** Inbound headers safe to forward verbatim to an upstream on a different host. */
function forwardableHeaders(inbound: Headers): Headers {
  const headers = new Headers(inbound);
  headers.delete("host");
  headers.delete("content-length"); // the body is re-read into an ArrayBuffer
  return headers;
}

/**
 * The identity worker's requireInternal routes (ADR-0022). /auth/* is proxied
 * path-verbatim, so the edge path IS the upstream path. The bare
 * /auth/device-reset REQUEST route is public (POST) — only its queue read
 * (GET) and decision sub-route are internal.
 */
function isInternalRoute(pathname: string, method: string): boolean {
  return (
    pathname === "/auth/face/enroll" ||
    (pathname === "/auth/device-reset" && method === "GET") ||
    (pathname.startsWith("/auth/device-reset/") && pathname.endsWith("/decision"))
  );
}

async function proxyIdentity(
  c: Context<{ Bindings: Env }>,
  options?: { forwardInboundHeaders?: boolean },
): Promise<Response> {
  const base = c.env.IDENTITY_URL ?? DEFAULT_IDENTITY_URL;
  const url = new URL(c.req.url);
  const target = new URL(url.pathname + url.search, base);
  let upstream: Response;
  const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
  const headers = options?.forwardInboundHeaders
    ? correlationHeaders(c, forwardableHeaders(c.req.raw.headers))
    : correlationHeaders(c, { "content-type": c.req.header("content-type") ?? "application/json" });
  const internalToken = c.env.IDENTITY_INTERNAL_TOKEN;
  if (internalToken && isInternalRoute(url.pathname, c.req.method)) {
    headers.set("x-identity-internal", internalToken);
  }
  try {
    upstream = await fetch(target, {
      method: c.req.method,
      headers,
      body: hasBody ? await c.req.raw.clone().arrayBuffer() : null,
    });
  } catch {
    return errorResponse(503, "identity-unavailable", `identity service at ${base} did not respond`);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "x-request-id": upstream.headers.get("x-request-id") ?? c.get("requestId"),
    },
  });
}
