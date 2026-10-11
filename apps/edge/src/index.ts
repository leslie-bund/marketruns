import { z } from "zod";
import { MarketDO } from "./do/market-do.js";
import { ProductDO } from "./do/product-do.js";
import { CartDO } from "./do/cart-do.js";
import { RunDO } from "./do/run-do.js";
import type { Env } from "./env.js";
import { errorResponse, parseClientCommand } from "./protocol.js";
import {
  DisputeRunRequestSchema,
  HandoffRefRequestSchema,
  InitiateHandoffRequestSchema,
  OfferProductRequestSchema,
  internalPost,
} from "./internal.js";

export { MarketDO, ProductDO, CartDO, RunDO };
export type { Env };

/**
 * Edge entry. Two kinds of traffic:
 *
 * - POST /command — a body validated against ClientCommandSchema and routed
 *   by discriminant to the Durable Object that owns it.
 * - Scoped REST/WS routes — /markets/:market, /products/:productId,
 *   /carts/:cartId, /runs/:runId — for views, WS gateways, and the internal
 *   operations the wire has no client command for yet (offers, handoff
 *   initiate/confirm, final delivery, config).
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.endsWith("/") && url.pathname.length > 1 ? url.pathname.slice(0, -1) : url.pathname;

    try {
      if (request.method === "GET" && (path === "/" || path === "/healthz")) {
        return new Response(JSON.stringify({ ok: true, service: "market-runs-edge" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (request.method === "POST" && path === "/command") {
        return dispatchCommand(request, env);
      }

      const segments = path.split("/").filter(Boolean);
      const scope = segments[0];
      const id = segments[1] ? decodeURIComponent(segments[1]) : undefined;
      const rest = "/" + segments.slice(2).join("/");

      if (id !== undefined && scope === "markets") return routeMarket(request, env, id, rest);
      if (id !== undefined && scope === "products") {
        const stub = env.PRODUCT_DO.get(env.PRODUCT_DO.idFromName(id));
        return stub.fetch(forwardRequest(request, rest));
      }
      if (id !== undefined && scope === "carts") {
        const stub = env.CART_DO.get(env.CART_DO.idFromName(id));
        return stub.fetch(forwardRequest(request, rest));
      }
      if (id !== undefined && scope === "runs") return routeRun(request, env, id, rest);

      return errorResponse(404, "not-found", `no route: ${request.method} ${path}`);
    } catch (error) {
      return errorResponse(500, "internal-error", error instanceof Error ? error.message : String(error));
    }
  },
};

async function dispatchCommand(request: Request, env: Env): Promise<Response> {
  const parsed = await parseClientCommand(request);
  if (!parsed.ok) return parsed.response;
  const command = parsed.command;

  switch (command.type) {
    case "intent.posted":
      return env.MARKET_DO.get(env.MARKET_DO.idFromName(command.market)).fetch(internalPost("/intent", command));
    case "negotiation.price-adjusted":
      return env.PRODUCT_DO.get(env.PRODUCT_DO.idFromName(command.productId)).fetch(internalPost("/price", command));
    case "product.accepted":
      return env.PRODUCT_DO.get(env.PRODUCT_DO.idFromName(command.productId)).fetch(internalPost("/accept", command));
    case "checkout.requested":
      return env.CART_DO.get(env.CART_DO.idFromName(command.cartId)).fetch(internalPost("/checkout", command));
    case "handoff.challenge-scanned":
      return env.RUN_DO.get(env.RUN_DO.idFromName(command.runId)).fetch(internalPost("/handoff/scan", command));
    case "run.location-updated":
      return env.RUN_DO.get(env.RUN_DO.idFromName(command.runId)).fetch(internalPost("/location", command));
    case "handoff.photo-captured": {
      // The command carries no runId (proto gap) so it cannot self-route:
      // address it to /runs/:runId/handoffs/:handoffId/photo instead.
      return errorResponse(
        400,
        "unroutable-command",
        "handoff.photo-captured has no runId; POST it to /runs/:runId/handoffs/:handoffId/photo",
      );
    }
  }
}

async function routeMarket(request: Request, env: Env, market: string, rest: string): Promise<Response> {
  if (request.method === "POST" && rest === "/offers") {
    return offerProduct(request, env, market);
  }
  const stub = env.MARKET_DO.get(env.MARKET_DO.idFromName(market));
  const headers = new Headers(request.headers);
  headers.set("x-market-id", market);
  return await stub.fetch(
    new Request(`http://do${rest}`, {
      method: request.method,
      headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }),
    }),
  );
}

/** A seller offers a product in response to an intent. */
async function offerProduct(request: Request, env: Env, market: string): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "invalid-body", "request body is not valid JSON");
  }
  const parsed = OfferProductRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid-body", "request body failed offer validation", { issues: parsed.error.issues });
  }
  if (parsed.data.market !== market) {
    return errorResponse(400, "invalid-body", `offer market ${parsed.data.market} does not match route market ${market}`);
  }
  const stub = env.PRODUCT_DO.get(env.PRODUCT_DO.idFromName(parsed.data.productId));
  return stub.fetch(internalPost("/offer", parsed.data, new Headers({ "x-market-id": market })));
}

async function routeRun(request: Request, env: Env, runId: string, rest: string): Promise<Response> {
  const stub = env.RUN_DO.get(env.RUN_DO.idFromName(runId));

  if (request.method === "POST" && rest === "/handoffs") {
    return forwardValidated(request, stub, "/handoff/initiate", InitiateHandoffRequestSchema);
  }
  const confirmMatch = rest.match(/^\/handoffs\/([^/]+)\/confirm$/);
  if (request.method === "POST" && confirmMatch?.[1]) {
    const body = { handoffId: decodeURIComponent(confirmMatch[1]) };
    const check = HandoffRefRequestSchema.safeParse(body);
    if (!check.success) return errorResponse(400, "invalid-body", "bad handoff id", { issues: check.error.issues });
    return await stub.fetch(internalPost("/handoff/confirm", check.data));
  }
  const photoMatch = rest.match(/^\/handoffs\/([^/]+)\/photo$/);
  if (request.method === "POST" && photoMatch?.[1]) {
    return forwardPhoto(request, stub, decodeURIComponent(photoMatch[1]));
  }
  if (request.method === "POST" && rest === "/delivery/final") {
    return await stub.fetch(internalPost("/delivery/final", {}));
  }
  if (request.method === "POST" && rest === "/dispute") {
    return forwardValidated(request, stub, "/dispute", DisputeRunRequestSchema);
  }
  return await stub.fetch(forwardRequest(request, rest));
}

/** Validate an internal body in the worker, then forward to the DO route. */
async function forwardValidated<S extends z.ZodTypeAny>(
  request: Request,
  stub: DurableObjectStub,
  path: string,
  schema: S,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "invalid-body", "request body is not valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid-body", "request body failed schema validation", { issues: parsed.error.issues });
  }
  return stub.fetch(internalPost(path, parsed.data));
}

/**
 * handoff.photo-captured is part of the client command union, so the body is
 * validated against ClientCommandSchema; the runId comes from the route
 * (the command itself has no runId — proto gap).
 */
async function forwardPhoto(request: Request, stub: DurableObjectStub, handoffId: string): Promise<Response> {
  const parsed = await parseClientCommand(request);
  if (!parsed.ok) return parsed.response;
  if (parsed.command.type !== "handoff.photo-captured") {
    return errorResponse(400, "invalid-body", `expected handoff.photo-captured, got ${parsed.command.type}`);
  }
  if (parsed.command.handoffId !== handoffId) {
    return errorResponse(400, "invalid-body", `photo addresses handoff ${parsed.command.handoffId}, not ${handoffId}`);
  }
  return stub.fetch(internalPost("/handoff/photo", parsed.command));
}

/** Forward a request to a DO preserving method, headers, and body. */
function forwardRequest(request: Request, rest: string): Request {
  return new Request(`http://do${rest}`, {
    method: request.method,
    headers: request.headers,
    ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }),
  });
}
