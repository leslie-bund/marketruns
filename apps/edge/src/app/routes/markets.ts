import { Hono } from "hono";
import type { Context } from "hono";
import {
  ActiveRunsResponseSchema,
  AdminListSchema,
  AdminRunEntrySchema,
  type ActiveRun,
  type LiveRun,
} from "@market-runs/proto";
import type { Env } from "../../config/env.js";
import { listMarketIds } from "../../config/markets.js";
import { errorResponse } from "../../do/runtime/index.js";
import { OfferProductRequestSchema } from "../../do/schemas.js";
import { internalPost } from "../../do/transport.js";
import { cartIdForBuyer } from "../../config/ids.js";
import { requireOps } from "../middleware/participant.js";
import { correlationHeaders } from "../middleware/request-id.js";

/**
 * /markets/:market — the market scope. Everything under the scope forwards
 * to the MarketDO (which owns intents, the close gate, and config); only the
 * seller's offer is intercepted here because it routes to a ProductDO keyed
 * by the client-chosen product id.
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

function marketStub(c: Context<{ Bindings: Env }>): DurableObjectStub {
  return c.env.MARKET_DO.get(c.env.MARKET_DO.idFromName(decodeURIComponent(c.req.param("market") ?? "")));
}

export function marketsRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  /**
   * The zone registry: seed zones plus every market anyone has joined (the
   * KV index heals itself on join).
   */
  app.get("/", async (c) => {
    const ids = await listMarketIds(c.env.MARKET_CONFIG);
    return c.json({ markets: ids.map((id) => ({ id })) });
  });

  /** A seller offers a product in response to an intent. */
  app.post("/:market/offers", async (c) => {
    const market = decodeURIComponent(c.req.param("market"));
    let raw: unknown;
    try {
      raw = await c.req.json();
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
    const stub = c.env.PRODUCT_DO.get(c.env.PRODUCT_DO.idFromName(parsed.data.productId));
    return stub.fetch(internalPost("/offer", parsed.data, correlationHeaders(c, { "x-market-id": market })));
  });

  /**
   * The caller's own cart in this market — the edge-authoritative answer to
   * "what is my cart id" (carts are per buyer per market, `cart:<market>:<buyerId>`).
   * The identity comes from the participant headers (ADR-0015); anonymous
   * callers get the shared anonymous cart. The accept response's
   * `cart.updated.cart.id` is the other authoritative source.
   */
  app.get("/:market/cart", (c) => {
    const market = decodeURIComponent(c.req.param("market"));
    const who = c.get("participant");
    const cartId = cartIdForBuyer(market, who.source === "header" ? who.id : "buyer:anonymous");
    return c.env.CART_DO.get(c.env.CART_DO.idFromName(cartId)).fetch(
      new Request("http://do/", { headers: correlationHeaders(c) }),
    );
  });

  /**
   * Live-run discovery: the caller's live runs in this market, read from the
   * archive's live_runs index — DOs are never listed (ADR-0017), and the index
   * is exactly the "which runs are in flight" enumeration. The identity comes
   * from the participant seam (ADR-0015); anonymous callers have no identity
   * and see nothing. Two caller shapes:
   *
   * - Runner: runs whose runnerId matches the caller's id. MVP posture
   *   (ADR-0013): every run is assigned to runner:internal, so a caller
   *   identified as runner:internal sees every live run in the market; any
   *   other runner id sees none. That is the accepted dev-stage posture
   *   while the header seam stands in for real auth — the trip auction (v2)
   *   is what introduces per-runner assignment.
   * - Seller: runs whose storeIds contain the caller's store, given as the
   *   `storeId` query param. TRUST CAVEAT: the store registry (MarketDO /
   *   StoreSchema) records no owner participant id, so there is no
   *   server-side caller→store resolution yet — the param is
   *   client-asserted under the dev-stage header seam (ADR-0015), exactly
   *   like the identity headers themselves. When real auth lands, the
   *   seller→store mapping resolves server-side and the param goes away.
   *   The store reference is the store's trading identity as it appears on
   *   the run's Products (sellerName — the same textual reference
   *   archived_products.store_id records).
   *
   * Failure contract: live_runs is an index, not doctrine. When the archive is
   * unreachable or answers badly, the route degrades to `{ runs: [] }` with a
   * `warning` so the runner/seller screens keep working on their own stored
   * run id.
   */
  app.get("/:market/runs/active", async (c) => {
    const market = decodeURIComponent(c.req.param("market"));
    const who = c.get("participant");
    const degraded = (warning: string) => c.json(ActiveRunsResponseSchema.parse({ runs: [], warning }));
    if (who.source !== "header") {
      return c.json(ActiveRunsResponseSchema.parse({ runs: [] }));
    }
    const sellerStoreId = who.role === "seller" ? (c.req.query("storeId") ?? "") : "";
    if (who.role === "seller" && sellerStoreId === "") {
      return errorResponse(400, "invalid-query", "seller run discovery requires the caller's storeId query param");
    }
    if (!c.env.OPS_ARCHIVE_URL) {
      return degraded("live run discovery is unavailable: the live_runs index is not configured");
    }
    const target = new URL("/admin/runs", c.env.OPS_ARCHIVE_URL);
    target.searchParams.set("market", market);
    if (sellerStoreId !== "") target.searchParams.set("storeId", sellerStoreId);
    else target.searchParams.set("runnerId", who.id);
    target.searchParams.set("kind", "live");
    target.searchParams.set("limit", "200");
    let upstream: Response;
    try {
      upstream = await fetch(target, { headers: correlationHeaders(c) });
    } catch {
      return degraded("live run discovery is unavailable: the live_runs index did not respond");
    }
    if (!upstream.ok) {
      return degraded(`live run discovery is unavailable: the live_runs index answered ${upstream.status}`);
    }
    let raw: unknown;
    try {
      raw = await upstream.json();
    } catch {
      return degraded("live run discovery is unavailable: the live_runs index returned non-JSON");
    }
    const parsed = AdminListSchema(AdminRunEntrySchema).safeParse(raw);
    if (!parsed.success) {
      return degraded("live run discovery is unavailable: the live_runs index returned an unexpected shape");
    }
    // Defensive: the archive already filters, but the wire shape is ours.
    const runs: ActiveRun[] = parsed.data.items
      .filter(
        (entry): entry is LiveRun =>
          entry.kind === "live" &&
          entry.retiredAt === null &&
          (sellerStoreId !== "" ? entry.storeIds.includes(sellerStoreId) : entry.runnerId === who.id),
      )
      .map((entry) => ({
        runId: entry.runId,
        market: entry.market,
        status: entry.status,
        buyerId: entry.buyerId,
        startedAt: entry.startedAt,
        stopCount: entry.stopCount,
      }))
      .sort((a, b) => b.startedAt - a.startedAt);
    return c.json(ActiveRunsResponseSchema.parse({ runs }));
  });

  /**
   * Market config writes are ops-only: the wildcard below would otherwise
   * forward them to the MarketDO unguarded. Client reads (GET /config) and
   * every other scope operation stay untouched.
   */
  app.post("/:market/config", requireOps(), (c) =>
    forwardTo(c, marketStub(c), "/config", { extraHeaders: { "x-market-id": decodeURIComponent(c.req.param("market") ?? "") } }),
  );

  /**
   * The filtered discovery read (proto/discovery.ts): open intents scoped to
   * the caller — ?shopItems= for sellers (the store's items, ADR-0006) and/or
   * the caller's buyer identity for buyers (the participant headers forward
   * verbatim, so the MarketDO resolves the header seam itself; ?buyerId= is
   * the explicit form) — with each intent's live products inlined, so clients
   * never fan out per intent. The wildcard below would forward this too; the
   * explicit route documents the pathway.
   */
  app.get("/:market/discovery", (c) =>
    forwardTo(c, marketStub(c), "/discovery", { extraHeaders: { "x-market-id": decodeURIComponent(c.req.param("market") ?? "") } }),
  );

  app.all("/:market", (c) => forwardTo(c, marketStub(c), "/", { extraHeaders: { "x-market-id": decodeURIComponent(c.req.param("market") ?? "") } }));
  app.all("/:market/*", (c) =>
    forwardTo(c, marketStub(c), scopeRest(c, 2), { extraHeaders: { "x-market-id": decodeURIComponent(c.req.param("market") ?? "") } }),
  );

  return app;
}

/** Forward a request to a DO preserving method, headers, query string, and body. */
export function forwardTo(
  c: Context<{ Bindings: Env }>,
  stub: DurableObjectStub,
  rest: string,
  options?: { extraHeaders?: Record<string, string> },
): Promise<Response> {
  const headers = new Headers(c.req.raw.headers);
  for (const [name, value] of Object.entries(options?.extraHeaders ?? {})) headers.set(name, value);
  // Correlation: the middleware-generated id rides even when the client sent none.
  headers.set("x-request-id", c.get("requestId"));
  const init: RequestInit = { method: c.req.method, headers };
  if (c.req.method !== "GET" && c.req.method !== "HEAD") init.body = c.req.raw.body;
  const search = new URL(c.req.url).search;
  return stub.fetch(new Request(`http://do${rest}${search}`, init));
}
