import { Hono, type Context } from "hono";
import { verifySessionToken } from "@market-runs/domain";
import { NotificationSchema } from "@market-runs/proto";
import type { Env } from "../../config/env.js";
import { participantObjectName } from "../../do/participant-do.js";
import { errorResponse, isWebSocketUpgrade } from "../../do/runtime/index.js";
import { internalPost } from "../../do/transport.js";
import { coreRegistry, headerAuthAllowed } from "../../registry/index.js";
import type { Participant } from "../middleware/participant.js";

const DEV_SESSION_SECRET = "market-runs-dev-session-secret";
const DEFAULT_NOTIFICATIONS_URL = "http://localhost:8791";

async function notificationParticipant(c: Context<{ Bindings: Env }>): Promise<Participant> {
  const resolved = c.get("participant");
  if (resolved.source !== "anonymous" && resolved.source !== "unauthenticated") return resolved;
  // Browser WebSockets cannot set Authorization. The same HMAC session is accepted
  // as access_token only on a WebSocket upgrade; never on an ordinary HTTP request.
  if (!isWebSocketUpgrade(c.req.raw)) return resolved;
  const token = c.req.query("access_token");
  const secret = c.env.IDENTITY_SESSION_SECRET ?? (headerAuthAllowed(c.env) ? DEV_SESSION_SECRET : undefined);
  if (token && secret) {
    const result = await verifySessionToken(token, secret);
    if (result.ok && ["buyer", "seller", "runner"].includes(result.payload.role)) {
      return { id: result.payload.participantId, role: result.payload.role as Participant["role"], source: "session" };
    }
  }
  return resolved;
}

function participantStub(env: Env, participantId: string): DurableObjectStub {
  return env.PARTICIPANT_DO.get(env.PARTICIPANT_DO.idFromName(participantObjectName(participantId)));
}

export function notificationsRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/live", async (c) => {
    const who = await notificationParticipant(c);
    if (who.source === "anonymous" || who.source === "unauthenticated" || who.role === "ops") {
      return errorResponse(401, "authentication-required", "a participant session is required for live notifications");
    }
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-participant-id", who.id);
    return participantStub(c.env, who.id).fetch(new Request("http://do/notifications/live", {
      method: "GET",
      headers,
    }));
  });

  app.get("/", async (c) => {
    const who = c.get("participant");
    if (who.source === "anonymous" || who.source === "unauthenticated" || who.role === "ops") {
      return errorResponse(401, "authentication-required", "a participant identity is required");
    }
    if (!c.env.NOTIFICATION_INTERNAL_TOKEN && !headerAuthAllowed(c.env)) {
      return errorResponse(503, "notification-auth-unconfigured", "NOTIFICATION_INTERNAL_TOKEN is required");
    }
    const target = new URL("/notifications", c.env.NOTIFICATIONS_URL ?? DEFAULT_NOTIFICATIONS_URL);
    for (const key of ["limit", "offset", "unread"]) {
      const value = c.req.query(key);
      if (value !== undefined) target.searchParams.set(key, value);
    }
    return fetch(target, {
      headers: {
        "x-participant-id": who.id,
        ...(c.env.NOTIFICATION_INTERNAL_TOKEN ? { "x-notification-internal": c.env.NOTIFICATION_INTERNAL_TOKEN } : {}),
      },
    });
  });

  app.post("/read", async (c) => {
    const who = c.get("participant");
    if (who.source === "anonymous" || who.source === "unauthenticated" || who.role === "ops") {
      return errorResponse(401, "authentication-required", "a participant identity is required");
    }
    if (!c.env.NOTIFICATION_INTERNAL_TOKEN && !headerAuthAllowed(c.env)) {
      return errorResponse(503, "notification-auth-unconfigured", "NOTIFICATION_INTERNAL_TOKEN is required");
    }
    return fetch(`${c.env.NOTIFICATIONS_URL ?? DEFAULT_NOTIFICATIONS_URL}/notifications/read`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-participant-id": who.id,
        ...(c.env.NOTIFICATION_INTERNAL_TOKEN ? { "x-notification-internal": c.env.NOTIFICATION_INTERNAL_TOKEN } : {}),
      },
      body: c.req.raw.body,
    });
  });

  return app;
}

/** Trusted notifications-worker → participant-socket delivery; not a public recipient-injection API. */
export function internalNotificationsRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/deliver", async (c) => {
    const configured = c.env.NOTIFICATION_INTERNAL_TOKEN;
    if (configured && c.req.header("x-notification-internal") !== configured) {
      return errorResponse(401, "unauthorized", "valid notification internal authentication is required");
    }
    if (!configured && !headerAuthAllowed(c.env)) {
      return errorResponse(503, "notification-auth-unconfigured", "NOTIFICATION_INTERNAL_TOKEN is required");
    }
    let body: unknown;
    try { body = await c.req.json(); } catch { return errorResponse(400, "invalid-body", "request body is not valid JSON"); }
    const parsed = NotificationSchema.safeParse(body);
    if (!parsed.success) return errorResponse(400, "invalid-body", "notification failed schema validation");
    return participantStub(c.env, parsed.data.recipientId).fetch(internalPost("/notify", parsed.data));
  });
  return app;
}

/** Minimal internal contact projection: email for receipts/security only, never the full participant profile. */
export function notificationContactRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/:participantId", async (c) => {
    const configured = c.env.NOTIFICATION_INTERNAL_TOKEN;
    if (configured && c.req.header("x-notification-internal") !== configured) {
      return errorResponse(401, "unauthorized", "valid notification internal authentication is required");
    }
    if (!configured && !headerAuthAllowed(c.env)) {
      return errorResponse(503, "notification-auth-unconfigured", "NOTIFICATION_INTERNAL_TOKEN is required");
    }
    const participant = await coreRegistry(c.env).participant(c.req.param("participantId"));
    if (!participant?.email) return errorResponse(404, "contact-not-found", "participant has no notification email");
    return c.json({ email: participant.email });
  });
  return app;
}
