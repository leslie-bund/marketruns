import type { Context, MiddlewareHandler } from "hono";
import { RequestIdSchema } from "@market-runs/proto";
import type { Env } from "../../config/env.js";
import type { Participant } from "./participant.js";

/**
 * Request correlation (x-request-id) — the minimum-viable trace seam.
 *
 * Every inbound request gets a correlation id: the caller's own header when
 * it is well-formed (1–64 chars of a safe charset, proto RequestIdSchema),
 * else a generated UUID. The id is set on the Hono context (`requestId`),
 * echoed on every response as `x-request-id`, and threaded onto internal DO
 * fetches via `correlationHeaders` / `forwardTo` so one user action is
 * traceable edge → DO → queue → archive/identity/payments.
 *
 * One structured log line per request: a single JSON.stringify with
 * { requestId, method, path, status, ms, participantId? } — parseable, cheap,
 * no bodies, no PII beyond the participant id.
 */

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

/** Honor a well-formed inbound id; otherwise generate one. */
export function resolveRequestId(header: string | undefined): string {
  return header !== undefined && RequestIdSchema.safeParse(header).success ? header : crypto.randomUUID();
}

/** The one structured log line per request (pure, so tests can pin its shape). */
export function requestLogLine(record: {
  requestId: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  participantId?: string;
}): string {
  return JSON.stringify(record);
}

export function requestId(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const id = resolveRequestId(c.req.header("x-request-id"));
    c.set("requestId", id);
    const started = Date.now();
    try {
      await next();
    } finally {
      // 101 WebSocket upgrade responses can carry immutable headers in the
      // runtime — the echo is best-effort there, the log line is not.
      try {
        c.res.headers.set("x-request-id", id);
      } catch {
        /* immutable response (upgrade); skip the echo */
      }
      const who = c.get("participant") as Participant | undefined;
      console.log(
        requestLogLine({
          requestId: id,
          method: c.req.method,
          path: new URL(c.req.url).pathname,
          status: c.res.status,
          ms: Date.now() - started,
          ...(who ? { participantId: who.id } : {}),
        }),
      );
    }
  };
}

/**
 * Headers for an internal DO fetch that carry the correlation id (merged over
 * any caller-supplied headers, e.g. x-market-id / x-participant-id).
 */
export function correlationHeaders(c: Context<{ Bindings: Env }>, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("x-request-id", c.get("requestId"));
  return headers;
}
