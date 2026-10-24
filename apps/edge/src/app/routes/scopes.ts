import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Env } from "../../config/env.js";
import { errorResponse, expectCommand, parseClientCommand } from "../../do/runtime/index.js";
import { LEGACY_REGISTRY_NAME, participantObjectName } from "../../do/participant-do.js";
import {
  DisputeRunRequestSchema,
  HandoffRefRequestSchema,
  InitiateHandoffRequestSchema,
} from "../../do/schemas.js";
import { internalPost } from "../../do/transport.js";
import { forwardTo } from "./markets.js";
import { correlationHeaders } from "../middleware/request-id.js";
import { coreRegistry } from "../../registry/index.js";
import { requireTransactionRole } from "../middleware/participant.js";

/**
 * The per-object scopes: /products/:productId, /carts/:cartId, /runs/:runId.
 * Each scope forwards to its Durable Object, which owns the object's routes
 * (including WebSocket upgrades — the 101 passes straight through). The run
 * scope intercepts the wire-facing handoff/delivery/dispute operations to
 * validate their bodies before they reach the RunDO.
 */


/**
 * The remainder of the path after the scope prefix (e.g. "/intents" for
 * /markets/Balogun/intents). Hono does not expose wildcard segments as
 * params, so slice the pathname after the second slash. DOs normalise
 * trailing slashes themselves.
 */
function scopeRest(c: Context<{ Bindings: Env }>, prefixSegments: number): string {
  const path = new URL(c.req.url).pathname;
  let idx = 0;
  for (let i = 0; i < prefixSegments; i += 1) idx = path.indexOf("/", idx + 1);
  if (idx === -1) return "/";
  return path.slice(idx) || "/";
}

function productStub(c: Context<{ Bindings: Env }>): DurableObjectStub {
  return c.env.PRODUCT_DO.get(c.env.PRODUCT_DO.idFromName(decodeURIComponent(c.req.param("productId") ?? "")));
}
function cartStub(c: Context<{ Bindings: Env }>): DurableObjectStub {
  return c.env.CART_DO.get(c.env.CART_DO.idFromName(decodeURIComponent(c.req.param("cartId") ?? "")));
}
function runStub(c: Context<{ Bindings: Env }>): DurableObjectStub {
  return c.env.RUN_DO.get(c.env.RUN_DO.idFromName(decodeURIComponent(c.req.param("runId") ?? "")));
}

export function productsRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.all("/:productId", (c) => forwardTo(c, productStub(c), "/"));
  app.all("/:productId/*", (c) => forwardTo(c, productStub(c), scopeRest(c, 2)));
  return app;
}

/** /participants/:participantId — the participant registry read path. */
export function participantsRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.all("/:participantId", async (c) => {
    const participantId = decodeURIComponent(c.req.param("participantId") ?? "");
    const who = c.get("participant");
    if (who.source === "session" && who.id !== participantId) {
      return errorResponse(403, "forbidden", "participants may read only their own durable profile");
    }
    const durable = await coreRegistry(c.env).participant(participantId);
    if (durable) return c.json({ participant: durable });
    const target = `http://do/participant/${encodeURIComponent(participantId)}`;
    const stub = c.env.PARTICIPANT_DO.get(c.env.PARTICIPANT_DO.idFromName(participantObjectName(participantId)));
    const response = await stub.fetch(new Request(target, { headers: correlationHeaders(c) }));
    if (response.status !== 404) return response;
    const legacy = c.env.PARTICIPANT_DO.get(c.env.PARTICIPANT_DO.idFromName(LEGACY_REGISTRY_NAME));
    return legacy.fetch(new Request(target, { headers: correlationHeaders(c) }));
  });
  return app;
}

export function cartsRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.all("/:cartId", (c) => forwardTo(c, cartStub(c), "/"));
  app.all("/:cartId/*", (c) => forwardTo(c, cartStub(c), scopeRest(c, 2)));
  return app;
}

export function runsRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/:runId/claim", async (c) => {
    const denied = await requireTransactionRole(c, "runner");
    if (denied) return denied;
    const runId = decodeURIComponent(c.req.param("runId"));
    const runResponse = await runStub(c).fetch(new Request("http://do/", { headers: correlationHeaders(c) }));
    if (!runResponse.ok) return runResponse;
    const current = (await runResponse.json()) as { run?: { market?: string } };
    const market = current.run?.market;
    if (!market) return errorResponse(404, "not-found", "run is unknown or retired");
    if (!(await coreRegistry(c.env).isInternalRunner(market, c.get("participant").id))) {
      return errorResponse(403, "forbidden", "runner is not in this market's internal pool");
    }
    return runStub(c).fetch(internalPost("/claim", { participantId: c.get("participant").id }, correlationHeaders(c, resolvedHeaders(c))));
  });

  app.post("/:runId/handoffs", async (c) => {
    const denied = await requireRunnerForSession(c);
    return denied ?? forwardValidated(c, "/handoff/initiate", InitiateHandoffRequestSchema);
  });
  app.post("/:runId/handoffs/:handoffId/confirm", async (c) => {
    const denied = await requireRunnerForSession(c);
    if (denied) return denied;
    const body = { handoffId: decodeURIComponent(c.req.param("handoffId")) };
    const check = HandoffRefRequestSchema.safeParse(body);
    if (!check.success) return errorResponse(400, "invalid-body", "bad handoff id", { issues: check.error.issues });
    return runStub(c).fetch(internalPost("/handoff/confirm", check.data, correlationHeaders(c, resolvedHeaders(c))));
  });
  app.post("/:runId/handoffs/:handoffId/photo", async (c) => {
    const denied = await requireRunnerForSession(c);
    return denied ?? forwardPhoto(c, decodeURIComponent(c.req.param("handoffId")));
  });
  app.post("/:runId/delivery/final", async (c) => {
    const denied = await requireRunnerForSession(c);
    if (denied) return denied;
    return runStub(c).fetch(internalPost("/delivery/final", {}, correlationHeaders(c, resolvedHeaders(c))));
  });
  app.post("/:runId/dispute", async (c) => {
    const who = c.get("participant");
    if (who.source === "unauthenticated") return errorResponse(401, "unauthorized", "a Bearer session is required");
    if (who.source === "session") {
      if (who.role !== "buyer" && who.role !== "seller" && who.role !== "runner") return errorResponse(403, "forbidden", "invalid participant role");
      const denied = await requireTransactionRole(c, who.role);
      if (denied) return denied;
    }
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return errorResponse(400, "invalid-body", "request body is not valid JSON"); }
    const parsed = DisputeRunRequestSchema.safeParse(raw);
    if (!parsed.success) return errorResponse(400, "invalid-body", "request body failed schema validation", { issues: parsed.error.issues });
    const body = who.source === "header" || who.source === "session" ? { ...parsed.data, raisedByParticipantId: who.id } : parsed.data;
    return runStub(c).fetch(internalPost("/dispute", body, correlationHeaders(c, resolvedHeaders(c))));
  });

  /**
   * The RunDO's /ops subtree (the ops-console run detail with its merged
   * dispute evidence, and ops settle) is console-internal: the console
   * reaches it on the stub directly, guarded by requireOps at /ops/api. The
   * wildcard below would forward these paths to ANY caller unguarded, and
   * ADR-0019 is unconditional — participants never enumerate dispute
   * evidence refs — so the subtree is refused here in every posture.
   */
  app.all("/:runId/ops", (c) => errorResponse(404, "not-found", `no route: ${c.req.method} ${new URL(c.req.url).pathname}`));
  app.all("/:runId/ops/*", (c) => errorResponse(404, "not-found", `no route: ${c.req.method} ${new URL(c.req.url).pathname}`));

  app.all("/:runId", (c) => forwardTo(c, runStub(c), "/"));
  app.all("/:runId/*", (c) => forwardTo(c, runStub(c), scopeRest(c, 2)));

  return app;
}

function resolvedHeaders(c: Context<{ Bindings: Env }>): Record<string, string> {
  const who = c.get("participant");
  return {
    "x-resolved-participant-id": who.id,
    "x-resolved-participant-role": who.role,
    "x-resolved-participant-source": who.source,
  };
}

async function requireRunnerForSession(c: Context<{ Bindings: Env }>): Promise<Response | null> {
  const source = c.get("participant").source;
  return source === "session" || source === "unauthenticated" ? requireTransactionRole(c, "runner") : null;
}

/** Validate an internal body in the worker, then forward to the DO route. */
async function forwardValidated<S extends z.ZodTypeAny>(
  c: Context<{ Bindings: Env }>,
  path: string,
  schema: S,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return errorResponse(400, "invalid-body", "request body is not valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid-body", "request body failed schema validation", { issues: parsed.error.issues });
  }
  return runStub(c).fetch(internalPost(path, parsed.data, correlationHeaders(c, resolvedHeaders(c))));
}

/**
 * handoff.photo-captured is part of the client command union, so the body is
 * validated against ClientCommandSchema; the runId comes from the route
 * (the command itself has no runId — proto gap).
 */
async function forwardPhoto(
  c: Context<{ Bindings: Env }>,
  handoffId: string,
): Promise<Response> {
  const parsed = await parseClientCommand(c.req.raw);
  if (!parsed.ok) return parsed.response;
  const command = expectCommand(parsed, "handoff.photo-captured");
  if (command instanceof Response) return command;
  if (command.handoffId !== handoffId) {
    return errorResponse(400, "invalid-body", `photo addresses handoff ${command.handoffId}, not ${handoffId}`);
  }
  return runStub(c).fetch(internalPost("/handoff/photo", command, correlationHeaders(c, resolvedHeaders(c))));
}
