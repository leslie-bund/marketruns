import { Hono } from "hono";
import type { Context } from "hono";
import {
  ActiveRunsResponseSchema,
  AdminListSchema,
  AdminRunEntrySchema,
  MarketRegistryResponseSchema,
  type ActiveRun,
  type LiveRun,
} from "@market-runs/proto";
import type { Env } from "../../config/env.js";
import { errorResponse, isWebSocketUpgrade } from "../../do/runtime/index.js";
import { OfferProductRequestSchema } from "../../do/schemas.js";
import { internalPost } from "../../do/transport.js";
import { cartIdForBuyer } from "../../config/ids.js";
import { requireTransactionRole } from "../middleware/participant.js";
import { requireOpsRole, withOpsAuth } from "../../ops-console/auth.js";
import { correlationHeaders } from "../middleware/request-id.js";
import { coreRegistry } from "../../registry/index.js";

function scopeRest(c: Context<{ Bindings: Env }>, prefixSegments: number): string {
  const path = new URL(c.req.url).pathname;
  let idx = 0;
  for (let i = 0; i < prefixSegments; i += 1) idx = path.indexOf("/", idx + 1);
  if (idx === -1) return "/";
  return path.slice(idx) || "/";
}

function marketStub(c: Context<{ Bindings: Env }>): DurableObjectStub {
  return c.env.MARKET_DO.get(c.env.MARKET_DO.idFromName(decodeURIComponent(c.req.param("market") ?? "")));
}

function resolvedHeaders(c: Context<{ Bindings: Env }>, storeId?: string): Record<string, string> {
  const who = c.get("participant");
  return {
    "x-resolved-participant-id": who.id,
    "x-resolved-participant-role": who.role,
    "x-resolved-participant-source": who.source,
    ...(storeId ? { "x-store-id": storeId } : {}),
  };
}

async function ownedStore(c: Context<{ Bindings: Env }>, storeId: string, market: string) {
  const store = await coreRegistry(c.env).store(storeId);
  if (!store || store.market.toLowerCase() !== market.toLowerCase()) return null;
  return store.sellerParticipantId === c.get("participant").id ? store : null;
}

export function marketsRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/", async (c) => {
    const filter = c.req.query("market")?.trim().toLowerCase();
    const markets = await coreRegistry(c.env).listMarkets();
    return c.json(MarketRegistryResponseSchema.parse({ markets: markets.filter((market) => !filter || market.id.toLowerCase() === filter || market.name.toLowerCase() === filter) }));
  });

  app.post("/:market/offers", async (c) => {
    const denied = await requireTransactionRole(c, "seller");
    if (denied) return denied;
    const market = decodeURIComponent(c.req.param("market"));
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return errorResponse(400, "invalid-body", "request body is not valid JSON"); }
    const parsed = OfferProductRequestSchema.safeParse(raw);
    if (!parsed.success) return errorResponse(400, "invalid-body", "request body failed offer validation", { issues: parsed.error.issues });
    if (parsed.data.market !== market) return errorResponse(400, "invalid-body", `offer market ${parsed.data.market} does not match route market ${market}`);
    let data = parsed.data;
    if (c.get("participant").source === "session") {
      if (!data.storeId) return errorResponse(400, "invalid-body", "authenticated offers require storeId");
      const store = await ownedStore(c, data.storeId, market);
      if (!store) return errorResponse(403, "forbidden", "seller does not own this store in the market");
      if (!store.shopItems.some((item) => item.toLowerCase() === data.shopItem.toLowerCase())) {
        return errorResponse(403, "forbidden", "shopItem is not registered to this store");
      }
      data = { ...data, storeId: store.id, sellerParticipantId: store.sellerParticipantId, sellerName: store.name, exchangePoint: store.exchangePoint };
    }
    const stub = c.env.PRODUCT_DO.get(c.env.PRODUCT_DO.idFromName(data.productId));
    return stub.fetch(internalPost("/offer", data, correlationHeaders(c, { "x-market-id": market, ...resolvedHeaders(c) })));
  });

  app.get("/:market/cart", (c) => {
    const market = decodeURIComponent(c.req.param("market"));
    const who = c.get("participant");
    if (who.source === "unauthenticated") return errorResponse(401, "unauthorized", "a Bearer session is required");
    const buyerId = who.source === "anonymous" ? "buyer:anonymous" : who.id;
    const cartId = cartIdForBuyer(market, buyerId);
    return c.env.CART_DO.get(c.env.CART_DO.idFromName(cartId)).fetch(new Request("http://do/", { headers: correlationHeaders(c) }));
  });

  app.get("/:market/runs/active", async (c) => {
    const market = decodeURIComponent(c.req.param("market"));
    const who = c.get("participant");
    if (who.source === "unauthenticated") return errorResponse(401, "unauthorized", "a Bearer session is required");
    if (who.source === "anonymous") return c.json(ActiveRunsResponseSchema.parse({ runs: [] }));
    const degraded = (warning: string) => c.json(ActiveRunsResponseSchema.parse({ runs: [], warning }));
    let sellerStoreId = "";
    let includeUnassigned = false;
    if (who.role === "seller") {
      sellerStoreId = c.req.query("storeId") ?? "";
      if (!sellerStoreId) return errorResponse(400, "invalid-query", "seller run discovery requires storeId");
      if (who.source === "session" && !(await ownedStore(c, sellerStoreId, market))) {
        return errorResponse(403, "forbidden", "seller does not own this store in the market");
      }
    } else if (who.role === "runner" && who.source === "session") {
      if (!(await coreRegistry(c.env).isInternalRunner(market, who.id))) return errorResponse(403, "forbidden", "runner is not in this market's internal pool");
      includeUnassigned = true;
    }
    if (!c.env.OPS_ARCHIVE_URL) return degraded("live run discovery is unavailable: the live_runs index is not configured");
    const target = new URL("/admin/runs", c.env.OPS_ARCHIVE_URL);
    target.searchParams.set("market", market);
    if (sellerStoreId) target.searchParams.set("storeId", sellerStoreId);
    else if (!includeUnassigned) target.searchParams.set("runnerId", who.id);
    target.searchParams.set("kind", "live");
    target.searchParams.set("limit", "200");
    let upstream: Response;
    try { upstream = await fetch(target, { headers: correlationHeaders(c) }); }
    catch { return degraded("live run discovery is unavailable: the live_runs index did not respond"); }
    if (!upstream.ok) return degraded(`live run discovery is unavailable: the live_runs index answered ${upstream.status}`);
    let raw: unknown;
    try { raw = await upstream.json(); } catch { return degraded("live run discovery is unavailable: the live_runs index returned non-JSON"); }
    const parsed = AdminListSchema(AdminRunEntrySchema).safeParse(raw);
    if (!parsed.success) return degraded("live run discovery is unavailable: the live_runs index returned an unexpected shape");
    const runs: ActiveRun[] = parsed.data.items
      .filter((entry): entry is LiveRun => entry.kind === "live" && entry.retiredAt === null &&
        (sellerStoreId ? entry.storeIds.includes(sellerStoreId) : entry.runnerId === who.id || (includeUnassigned && entry.runnerId === null)))
      .map((entry) => ({ runId: entry.runId, market: entry.market, status: entry.status, buyerId: entry.buyerId, startedAt: entry.startedAt, stopCount: entry.stopCount }))
      .sort((a, b) => b.startedAt - a.startedAt);
    return c.json(ActiveRunsResponseSchema.parse({ runs }));
  });

  /** Market config writes are ops-only; Better Auth is the deployed guard. */
  app.post("/:market/config", withOpsAuth(), requireOpsRole("admin"), (c) =>
    forwardTo(c, marketStub(c), "/config", { extraHeaders: { "x-market-id": decodeURIComponent(c.req.param("market") ?? "") } }),
  );

  app.get("/:market/discovery", async (c) => {
    const who = c.get("participant");
    const market = decodeURIComponent(c.req.param("market"));
    const search = new URL(c.req.url).searchParams;
    if (who.source === "session" && who.role === "buyer") search.set("buyerId", who.id);
    if (who.source === "session" && who.role === "seller") {
      const storeId = c.req.query("storeId") ?? "";
      const store = storeId ? await ownedStore(c, storeId, market) : null;
      if (!store) return errorResponse(403, "forbidden", "seller discovery requires an owned storeId");
      search.set("shopItems", store.shopItems.join(","));
    }
    return forwardTo(c, marketStub(c), "/discovery", { extraHeaders: { "x-market-id": market }, search: `?${search.toString()}` });
  });

  app.all("/:market", async (c) => {
    const market = decodeURIComponent(c.req.param("market"));
    const storeId = await authorizeSocket(c, market);
    if (storeId instanceof Response) return storeId;
    return forwardTo(c, marketStub(c), "/", { extraHeaders: { "x-market-id": market, ...resolvedHeaders(c, storeId) } });
  });
  app.all("/:market/*", async (c) => {
    const market = decodeURIComponent(c.req.param("market"));
    const storeId = await authorizeSocket(c, market);
    if (storeId instanceof Response) return storeId;
    return forwardTo(c, marketStub(c), scopeRest(c, 2), { extraHeaders: { "x-market-id": market, ...resolvedHeaders(c, storeId) } });
  });
  return app;
}

/** Authenticate WS identity and validate seller store attachment before any upgrade. */
async function authorizeSocket(c: Context<{ Bindings: Env }>, market: string): Promise<string | undefined | Response> {
  if (!isWebSocketUpgrade(c.req.raw)) return undefined;
  const who = c.get("participant");
  if (who.source === "unauthenticated") return errorResponse(401, "unauthorized", "WebSockets require a Bearer session");
  if (who.source === "session" && who.role === "seller") {
    const storeId = c.req.query("storeId") ?? "";
    const store = storeId ? await ownedStore(c, storeId, market) : null;
    if (!store) return errorResponse(403, "forbidden", "seller WebSocket requires an owned storeId");
    // Connection alone never makes a seller online; the first valid foreground fix does.
    return storeId;
  }
  return undefined;
}

/** Forward method/body plus server-resolved identity; client identity headers are never authoritative. */
export function forwardTo(
  c: Context<{ Bindings: Env }>,
  stub: DurableObjectStub,
  rest: string,
  options?: { extraHeaders?: Record<string, string>; search?: string },
): Promise<Response> {
  const headers = new Headers(c.req.raw.headers);
  const who = c.get("participant") ?? { id: "anonymous", role: "buyer" as const, source: "anonymous" as const };
  if (who.source !== "anonymous") headers.set("x-participant-id", who.id);
  else headers.delete("x-participant-id");
  headers.set("x-participant-role", who.role);
  headers.set("x-resolved-participant-id", who.id);
  headers.set("x-resolved-participant-role", who.role);
  headers.set("x-resolved-participant-source", who.source);
  for (const [name, value] of Object.entries(options?.extraHeaders ?? {})) headers.set(name, value);
  headers.set("x-request-id", c.get("requestId"));
  const init: RequestInit = { method: c.req.method, headers };
  if (c.req.method !== "GET" && c.req.method !== "HEAD") init.body = c.req.raw.body;
  const search = options?.search ?? new URL(c.req.url).search;
  return stub.fetch(new Request(`http://do${rest}${search}`, init));
}
