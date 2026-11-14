import { Hono } from "hono";
import { cors } from "hono/cors";
import { IdentityKycRequestSchema, IdentityKycResponseSchema } from "@market-runs/proto";
import type { Env } from "../config/env.js";
import { validateEdgeTopology } from "../config/topology.js";
import { errorResponse, jsonResponse } from "../do/runtime/index.js";
import { participantObjectName } from "../do/participant-do.js";
import { internalPost } from "../do/transport.js";
import { coreRegistry, headerAuthAllowed } from "../registry/index.js";
import { participant } from "./middleware/participant.js";
import { correlationHeaders, requestId } from "./middleware/request-id.js";
import { opsConsole } from "../ops-console/index.js";
import { handleOpsAuth, withOpsAuth } from "../ops-console/auth.js";
import { commandRoute } from "./routes/command.js";
import { authRoute, callbacksRoute } from "./routes/auth.js";
import { paymentsRoute, webhooksRoute } from "./routes/payments.js";
import { capturesRoute } from "./routes/captures.js";
import { historyRoute } from "./routes/history.js";
import { marketsRoute } from "./routes/markets.js";
import { cartsRoute, participantsRoute, productsRoute, runsRoute } from "./routes/scopes.js";
import { internalNotificationsRoute, notificationContactRoute, notificationsRoute } from "./routes/notifications.js";

/** Hash both values first so token comparison has a fixed-length, constant-work loop. */
async function identityTokenMatches(provided: string | undefined, expected: string): Promise<boolean> {
  if (provided === undefined) return false;
  const encoder = new TextEncoder();
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(providedDigest);
  const right = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

/** Identity-worker-only KYC reconciliation. This is a DO write seam, not an /auth proxy. */
export function internalIdentityKycRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/kyc", async (c) => {
    const configured = c.env.IDENTITY_INTERNAL_TOKEN;
    const deployed = c.env.EDGE_ENV === "staging" || c.env.EDGE_ENV === "production";
    if (!configured && (deployed || !headerAuthAllowed(c.env))) {
      return errorResponse(503, "identity-auth-unconfigured", "IDENTITY_INTERNAL_TOKEN is required");
    }
    if (configured && !(await identityTokenMatches(c.req.header("x-identity-internal"), configured))) {
      return errorResponse(403, "unauthorized-internal", "valid identity internal authentication is required");
    }
    const parsed = IdentityKycRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid-request", "identity KYC reconciliation failed schema validation");
    const recorded = await c.env.PARTICIPANT_DO.get(
      c.env.PARTICIPANT_DO.idFromName(participantObjectName(parsed.data.participantId)),
    ).fetch(internalPost("/kyc", parsed.data, correlationHeaders(c)));
    if (!recorded.ok) return recorded;
    const body = IdentityKycResponseSchema.safeParse(await recorded.json());
    if (!body.success) return errorResponse(502, "bad-internal-response", "participant reconciliation response was invalid");
    // Staging preverified onboarding already joined the initial market; this seam only reconciles KYC.
    await coreRegistry(c.env).saveParticipant(body.data.participant);
    return jsonResponse(body.data);
  });
  return app;
}

/**
 * The edge application: Hono app, explicit routes, one visible auth seam.
 *
 *   app.use("*", participant())        — who is calling (ADR-0015)
 *   app.route("/ops", opsConsole())    — authenticated operator JSON API only
 *
 * Everything under a scope forwards to the owning Durable Object.
 */
export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // Browser clients (Expo web) call cross-origin; native apps don't care.
  // Dev allows any origin — restrict per deployment (ADR-0015 follow-up).
  app.use("*", cors());
  // Correlation id first: it wraps everything downstream so the one log line
  // per request measures the whole handling and the id is on the context for
  // every DO fetch / proxy below.
  app.use("*", requestId());
  app.use("*", participant());

  app.onError((error) =>
    errorResponse(500, "internal-error", error instanceof Error ? error.message : String(error)),
  );
  app.notFound((c) => errorResponse(404, "not-found", `no route: ${c.req.method} ${new URL(c.req.url).pathname}`));

  app.use("*", async (c, next) => {
    try {
      validateEdgeTopology(c.env);
      await next();
    } catch (error) {
      return errorResponse(503, "edge-topology-unconfigured", error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/", (c) => c.json({ ok: true, service: "market-runs-edge" }));
  app.get("/healthz", (c) => c.json({ ok: true, service: "market-runs-edge" }));

  app.route("/command", commandRoute());
  app.route("/auth", authRoute()); // → identity worker (apps/identity), IDENTITY_URL
  app.route("/payments", paymentsRoute()); // → payments worker (apps/payments), PAYMENTS_URL
  // Provider server-to-server callbacks, edge-proxied so one tunnel suffices.
  // The edge is a dumb pipe for both — signature/hash verification stays at
  // the owning worker (verif-hash at payments, provider signature at identity).
  app.route("/webhooks", webhooksRoute()); // → payments worker, PAYMENTS_URL
  app.route("/callbacks", callbacksRoute()); // → identity worker, IDENTITY_URL
  app.route("/captures", capturesRoute());
  app.route("/notifications", notificationsRoute());
  app.route("/internal/notifications", internalNotificationsRoute());
  app.route("/internal/notification-contact", notificationContactRoute());
  app.route("/internal/identity", internalIdentityKycRoute());
  app.route("/markets", marketsRoute());
  app.route("/history", historyRoute());
  app.route("/participants", participantsRoute());
  app.route("/products", productsRoute());
  app.route("/carts", cartsRoute());
  app.route("/runs", runsRoute());

  const ops = new Hono<{ Bindings: Env }>();
  // Dedicated apps/ops serves the UI. Only allow-listed auth endpoints are
  // public here; every operator API route requires the established ops guard.
  ops.all("/auth/*", handleOpsAuth);
  ops.use("/api/*", withOpsAuth());
  ops.route("/", opsConsole());
  app.route("/ops", ops);

  return app;
}
