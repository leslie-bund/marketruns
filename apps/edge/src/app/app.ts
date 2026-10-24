import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../config/env.js";
import { errorResponse } from "../do/runtime/index.js";
import { participant } from "./middleware/participant.js";
import { requestId } from "./middleware/request-id.js";
import { opsConsole } from "../ops-console/index.js";
import { handleOpsAuth, withOpsAuth } from "../ops-console/auth.js";
import { commandRoute } from "./routes/command.js";
import { authRoute, callbacksRoute } from "./routes/auth.js";
import { paymentsRoute, webhooksRoute } from "./routes/payments.js";
import { capturesRoute } from "./routes/captures.js";
import { marketsRoute } from "./routes/markets.js";
import { cartsRoute, participantsRoute, productsRoute, runsRoute } from "./routes/scopes.js";

/**
 * The edge application: Hono app, explicit routes, one visible auth seam.
 *
 *   app.use("*", participant())        — who is calling (ADR-0015)
 *   app.route("/ops", opsConsole())    — behind requireOps inside the console
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
  app.route("/markets", marketsRoute());
  app.route("/participants", participantsRoute());
  app.route("/products", productsRoute());
  app.route("/carts", cartsRoute());
  app.route("/runs", runsRoute());

  const ops = new Hono<{ Bindings: Env }>();
  ops.all("/auth/*", handleOpsAuth);
  ops.use("/api/*", withOpsAuth());
  ops.use("/", withOpsAuth());
  ops.route("/", opsConsole());
  app.route("/ops", ops);

  return app;
}
