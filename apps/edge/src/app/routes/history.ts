import { Hono } from "hono";
import { ParticipantHistorySchema } from "@market-runs/proto";
import type { Env } from "../../config/env.js";
import { errorResponse } from "../../do/runtime/index.js";
import { correlationHeaders } from "../middleware/request-id.js";

/** Session-scoped durable history; clients never choose the participant filter. */
export function historyRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/", async (c) => {
    const who = c.get("participant");
    if (who.source !== "session") return errorResponse(401, "unauthorized", "a Bearer session is required");
    if (who.role !== "buyer" && who.role !== "seller" && who.role !== "runner") {
      return errorResponse(403, "forbidden", "invalid participant role");
    }
    if (!c.env.OPS_ARCHIVE_URL) return errorResponse(503, "archive-unavailable", "OPS_ARCHIVE_URL is not configured on the edge worker");
    const target = new URL("/participant/history", c.env.OPS_ARCHIVE_URL);
    target.search = new URLSearchParams({ participantId: who.id, role: who.role }).toString();
    let upstream: Response;
    try {
      upstream = await (c.env.ARCHIVE_SERVICE ?? { fetch }).fetch(target, {
        headers: correlationHeaders(c, {
          ...(c.env.ARCHIVE_INTERNAL_TOKEN ? { "x-archive-internal": c.env.ARCHIVE_INTERNAL_TOKEN } : {}),
        }),
      });
    } catch {
      return errorResponse(503, "archive-unavailable", "the archive history service did not respond");
    }
    if (!upstream.ok) return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "application/json" } });
    const parsed = ParticipantHistorySchema.safeParse(await upstream.json().catch(() => null));
    if (!parsed.success) return errorResponse(502, "bad-archive-response", "participant history failed validation");
    return c.json(parsed.data);
  });
  return app;
}
