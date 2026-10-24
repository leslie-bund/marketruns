import { DurableObject } from "cloudflare:workers";
import { cartDeadline, floorRate, plusCodeToLocation } from "@market-runs/domain";
import type { Cart, CheckoutRequested, GeoPointValue, Product, ServerEvent } from "@market-runs/proto";
import { PaymentHoldViewSchema } from "@market-runs/proto";
import type { Env } from "../config/env.js";
import {
  acceptHibernatedWebSocket,
  broadcast,
  conflict,
  errorResponse,
  expectCommand,
  handleWebSocketClose,
  handleWebSocketError,
  handleWebSocketMessage,
  internalErrorGuard,
  isWebSocketUpgrade,
  jsonResponse,
  notFound,
  parseClientCommand,
  parseInternal,
  refusal,
  serializeEvent,
} from "./runtime/index.js";
import { STATE_KEY } from "./state.js";
import type { CartAppendRequest, GeoPoint, MarketConfig, RetireProductRequest } from "./schemas.js";
import { CartAppendRequestSchema, CloseGateResponseSchema, MarketConfigSchema } from "./schemas.js";
import { fetchInternal, internalPost } from "./transport.js";
import { routeTrip } from "./routing.js";
import { cartIdForBuyer, runIdForCart } from "../config/ids.js";

/** Dev default for the payments worker; override with PAYMENTS_URL. */
const PAYMENTS_URL_DEFAULT = "http://localhost:8790";

/**
 * The checkout tombstone key (separate from STATE_KEY). Doctrine (ADR-0010):
 * retirement = archive snapshot + delete DO storage. This tombstone is NOT
 * retained state — it is the minimal receipt a client needs to recover its
 * runId by retrying a checkout whose response it lost. It never resurrects
 * the cart, never re-opens acceptances, and never seeds a second run.
 */
const TOMBSTONE_KEY = "cart:tombstone";

/** What remains of a checked-out cart: just enough to answer a checkout retry. */
export interface CartTombstone {
  retired: true;
  cartId: string;
  runId: string;
  retiredAt: number;
}

/**
 * The checkout payment gate (dev default OFF): truthy = checkout requires a
 * verified hold at the payments worker. Unset/""/"0"/"false" keeps the
 * unpaid dev posture — demo flows and e2e tests run without a PSP.
 */
function paymentsRequired(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

interface CartEntry {
  product: Product;
  /** The product's market, recorded at acceptance so the one-market rule is checkable. */
  market: string;
}

interface CartState {
  cartId?: string;
  market?: string;
  /** The cart's owner: the buyer whose acceptances fill it (one cart per buyer per market). */
  buyerId?: string;
  entries: CartEntry[];
  /** Recorded once, on the first acceptance (ADR-0003). */
  firstAcceptedAt?: number;
  acceptanceCount: number;
  /** The shared lap-timer deadline (domain cartDeadline). */
  deadline?: number;
  status: "open" | "checked-out" | "retired";
  /** Deterministic-time seam: epoch offset added to Date.now(). 0 in production. */
  timeOffsetMs?: number;
}

/**
 * Per cart: the single shared lap-timer deadline (ADR-0003). One open cart per
 * buyer per market — the deadline is shared across acceptances *within a
 * buyer's cart*. On expiry the whole cart retires atomically — every unbought
 * product retires with it and none is ever resurrected.
 */
export class CartDO extends DurableObject<Env> {
  private state: CartState = { entries: [], acceptanceCount: 0, status: "open" };
  /** The checkout tombstone, when this DO's previous cart was checked out (null otherwise). */
  private tombstone: CartTombstone | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private now(): number {
    return Date.now() + (this.state.timeOffsetMs ?? 0);
  }

  async fetch(request: Request): Promise<Response> {
    // Doctrine: load state from storage at the start of every fetch.
    this.state =
      (await this.ctx.storage.get<CartState>(STATE_KEY)) ?? { entries: [], acceptanceCount: 0, status: "open" };
    this.tombstone = (await this.ctx.storage.get<CartTombstone>(TOMBSTONE_KEY)) ?? null;
    const url = new URL(request.url);
    const path = url.pathname.endsWith("/") && url.pathname.length > 1 ? url.pathname.slice(0, -1) : url.pathname;

    if (isWebSocketUpgrade(request)) return acceptHibernatedWebSocket(this.ctx);

    if (request.method === "POST" && path === "/accept") {
      const parsed = await parseInternal(request, CartAppendRequestSchema);
      if (!parsed.ok) return parsed.response;
      return internalErrorGuard(() => this.acceptProduct(parsed.data));
    }
    if (request.method === "POST" && path === "/checkout") {
      const parsed = await parseClientCommand(request);
      const command = expectCommand(parsed, "checkout.requested");
      if (command instanceof Response) return command;
      return internalErrorGuard(() => this.checkout(command, request.headers.get("x-request-id") ?? undefined));
    }
    if (request.method === "GET" && path === "/") {
      if (!this.state.cartId) return notFound("cart is empty or retired");
      const event: ServerEvent = { type: "cart.updated", cart: this.cartView() };
      return jsonResponse(event);
    }
    return notFound(`CartDO route not found: ${request.method} ${path}`);
  }

  /**
   * Accept a product into the cart: record firstAcceptedAt once, extend the
   * shared deadline per acceptance (domain cartDeadline), reschedule the alarm.
   */
  private async acceptProduct(data: CartAppendRequest): Promise<Response> {
    if (this.state.status !== "open") {
      return conflict(`cart is ${this.state.status}; new acceptances are refused`);
    }
    if (this.state.cartId && this.state.cartId !== data.cartId) {
      return conflict(`cart id mismatch: this cart is ${this.state.cartId}`);
    }
    if (this.state.market && this.state.market !== data.market) {
      return conflict(`a cart may only hold products from one market (${this.state.market})`);
    }
    if (this.state.entries.some((entry) => entry.product.id === data.product.id)) {
      return conflict(`product ${data.product.id} is already in this cart`);
    }

    const now = this.now();
    this.state.cartId = data.cartId;
    this.state.market = data.market;
    this.state.buyerId ??= data.buyerId;
    this.state.firstAcceptedAt ??= now;
    this.state.acceptanceCount += 1;
    this.state.deadline = cartDeadline(this.state.firstAcceptedAt, this.state.acceptanceCount);
    this.state.entries.push({ product: data.product, market: data.market });
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.ctx.storage.setAlarm(this.state.deadline);

    const event: ServerEvent = { type: "cart.updated", cart: this.cartView() };
    broadcast(this.ctx, event);
    return jsonResponse(event);
  }

  /**
   * Checkout: validate one market, the close gate (a clear refusal when the
   * market is too close to closing), and the floor-rate delivery; then create
   * the Run (idFromName on RUN_DO, stops seeded from the accepted products),
   * emit checkout.accepted, retire the cart and its products.
   */
  private async checkout(command: CheckoutRequested, requestId?: string): Promise<Response> {
    const state = this.state;
    // Correlation: thread the edge's request id onto every internal fetch and
    // queue message this checkout spawns (append-only trace seam).
    const correlation = requestId !== undefined ? { headers: { "x-request-id": requestId } } : {};
    if (!state.cartId || !state.market) {
      // No live cart. If the command addresses a cart this DO already checked
      // out, the tombstone answers the retry: 409 with the runId, so a client
      // that lost the original response recovers its run — never a second run.
      const tombstone = this.tombstone;
      if (tombstone && tombstone.cartId === command.cartId) {
        return errorResponse(
          409,
          "cart-already-checked-out",
          `cart ${command.cartId} was already checked out; the run is ${tombstone.runId}`,
          { runId: tombstone.runId, retiredAt: tombstone.retiredAt },
        );
      }
      return notFound("cart is empty or retired");
    }
    if (command.cartId !== state.cartId) {
      // A retry naming the retired cart (not the live one) still recovers its runId.
      const tombstone = this.tombstone;
      if (tombstone && tombstone.cartId === command.cartId) {
        return errorResponse(
          409,
          "cart-already-checked-out",
          `cart ${command.cartId} was already checked out; the run is ${tombstone.runId}`,
          { runId: tombstone.runId, retiredAt: tombstone.retiredAt },
        );
      }
      return conflict(`checkout.requested addresses cart ${command.cartId}, not this cart`);
    }
    if (state.status !== "open") return conflict(`cart is ${state.status}; checkout is refused`);
    // One buyer per cart: an identified caller may only check out their own cart.
    if (state.buyerId !== undefined && state.buyerId !== "buyer:anonymous" && command.buyerId !== undefined && command.buyerId !== state.buyerId) {
      return conflict(`cart ${state.cartId} belongs to ${state.buyerId}; ${command.buyerId} cannot check it out`);
    }
    const now = this.now();
    if (state.firstAcceptedAt === undefined || state.deadline === undefined) {
      return conflict("cart has no acceptance clock");
    }
    if (now >= state.deadline) {
      return refusal(
        "cart-deadline",
        `the cart deadline lapsed at ${new Date(state.deadline).toISOString()} — the whole cart retires and is never resurrected`,
      );
    }

    // One market per cart (GLOSSARY.md).
    const markets = new Set(state.entries.map((entry) => entry.market));
    if (markets.size !== 1 || !markets.has(state.market)) {
      return conflict("a cart may only contain products from one market");
    }

    const marketStub = this.env.MARKET_DO.get(this.env.MARKET_DO.idFromName(state.market));

    // The market close gate: refuse clearly when the trip cannot finish before close.
    const gate = await fetchInternal(marketStub, new Request("http://do/close-gate", correlation), CloseGateResponseSchema);
    if (gate instanceof Response) return gate;
    if (!gate.ok) {
      return refusal("market-close-gate", gate.refusal ?? "the market is too close to closing for this trip");
    }

    const config = await this.marketConfig(marketStub, correlation);
    if (config instanceof Response) return config;

    // Seed stops grouped by seller exchange point, preserving acceptance order.
    const stopOrder: Array<{ sellerName: string; exchangePoint: string; storeId?: string; sellerParticipantId?: string }> = [];
    for (const entry of state.entries) {
      const product = entry.product;
      if (!stopOrder.some((stop) => stop.sellerName === product.sellerName && stop.exchangePoint === product.exchangePoint)) {
        stopOrder.push({
          sellerName: product.sellerName,
          exchangePoint: product.exchangePoint,
          ...(product.storeId ? { storeId: product.storeId } : {}),
          ...(product.sellerParticipantId ? { sellerParticipantId: product.sellerParticipantId } : {}),
        });
      }
    }

    // Routing at checkout (AGENTS.md stack): resolve every waypoint to
    // coordinates, call OSRM once, cache the result on the Run. Any failure
    // falls back to the market's static floor-rate inputs — checkout never
    // blocks on the routing service.
    const geography = this.resolveGeography(stopOrder, command, config);
    const trip =
      geography && this.env.OSRM_BASE_URL ? await routeTrip(this.env.OSRM_BASE_URL, geography.waypoints) : null;

    // MVP: internal runners at the floor rate only (ADR-0013).
    const floorRateKobo = floorRate({
      ...config.floorRate,
      ...(trip ? { distanceMeters: trip.distanceMeters, estimatedDurationMs: trip.durationSeconds * 1000 } : {}),
    });

    const stops = stopOrder.map((stop, index) => ({
      sellerName: stop.sellerName,
      ...(stop.storeId ? { storeId: stop.storeId } : {}),
      ...(stop.sellerParticipantId ? { sellerParticipantId: stop.sellerParticipantId } : {}),
      exchangePoint: stop.exchangePoint,
      shopItems: state.entries
        .filter((entry) => entry.product.sellerName === stop.sellerName && entry.product.exchangePoint === stop.exchangePoint)
        .map((entry) => entry.product.shopItem),
      status: (index === 0 ? "next" : "upcoming") as "next" | "upcoming",
      ...(trip?.legs[index]
        ? { legDistanceMeters: trip.legs[index].distanceMeters, legDurationSeconds: trip.legs[index].durationSeconds }
        : {}),
      ...(geography ? { location: geography.stopLocations[index]! } : {}),
    }));

    // Seller participant ids resolve payout accounts; display names remain legacy dev fallbacks.
    const legs: Array<{ sellerId: string; amountKobo: number }> = [];
    for (const entry of state.entries) {
      const sellerId = entry.product.sellerParticipantId ?? entry.product.sellerName;
      const leg = legs.find((candidate) => candidate.sellerId === sellerId);
      if (leg) leg.amountKobo += entry.product.priceKobo;
      else legs.push({ sellerId, amountKobo: entry.product.priceKobo });
    }

    // The buyer is the checkout caller, falling back to the cart's recorded owner.
    const buyerId = command.buyerId ?? state.buyerId ?? "buyer:anonymous";

    // Payment gate (Env.PAYMENTS_REQUIRED, dev default OFF): checkout requires
    // a payments-worker hold covering the checkout total (goods + delivery),
    // belonging to this cart and this buyer. When the gate is off, checkout
    // is unpaid and behaves exactly as before — demo flows and e2e tests run
    // without a PSP. The gate never CREATES money decisions: the hold was
    // verified server-side at the payments worker; here we only check it.
    if (paymentsRequired(this.env.PAYMENTS_REQUIRED)) {
      if (!command.paymentRef) {
        return refusal(
          "payment-required",
          "checkout requires a confirmed payment hold — confirm the charge and pass its txRef as paymentRef",
        );
      }
      const checkoutTotalKobo = legs.reduce((sum, leg) => sum + leg.amountKobo, 0) + floorRateKobo;
      const gateFailure = await this.verifyCheckoutHold(command.paymentRef, {
        cartId: state.cartId,
        buyerId,
        checkoutTotalKobo,
      });
      if (gateFailure) return gateFailure;
    }

    const runId = runIdForCart(state.cartId);
    const run = {
      id: runId,
      market: state.market,
      status: (this.env.ALLOW_HEADER_AUTH === "true" ? "assigned" : "unassigned") as "assigned" | "unassigned",
      floorRateKobo,
      delivery: command.delivery,
      stops,
      handoffs: [],
      ...(trip
        ? {
            route: {
              distanceMeters: trip.distanceMeters,
              durationSeconds: trip.durationSeconds,
              geometry: trip.geometry,
              ...(geography ? { destination: geography.deliveryLocation } : {}),
            },
          }
        : {}),
    };

    // Production runs wait for an atomic pool claim. The explicit header-auth
    // demo posture retains its seeded internal runner so existing rehearsals
    // can drive the complete trip without casting a separate pool member.
    const runnerId = this.env.ALLOW_HEADER_AUTH === "true" ? "runner:internal" : null;
    const runStub = this.env.RUN_DO.get(this.env.RUN_DO.idFromName(runId));
    const seeded = await runStub.fetch(
      internalPost(
        "/seed",
        {
          run,
          legs,
          settlement: config.settlement,
          buyerId,
          runnerId,
        },
        correlation.headers !== undefined ? new Headers(correlation.headers) : undefined,
      ),
    );
    if (!seeded.ok) {
      return new Response(await seeded.text(), { status: 502, headers: { "content-type": "application/json" } });
    }

    // Bind the hold to the run (gated checkouts only): the refund rail finds
    // holds by runId at settlement. Best-effort with a loud log — the hold is
    // already verified and recorded; a missed bind is recoverable by txRef.
    if (command.paymentRef && paymentsRequired(this.env.PAYMENTS_REQUIRED)) {
      await this.bindHoldToRun(command.paymentRef, runId);
    }

    // Announce the live Run so the archive consumer can maintain the
    // live_runs index (admin ops dashboard). Fire-and-forget: a queue
    // failure never blocks checkout — the index heals on run.retired.
    // storeIds: the cart's distinct store references (Products carry the
    // store's trading identity as sellerName — stops are per-store) so a
    // seller can discover runs containing their products.
    const storeIds = [...new Set(state.entries.map((entry) => entry.product.storeId ?? entry.product.sellerName))];
    const runStarted: ServerEvent = {
      type: "run.started",
      runId,
      market: state.market,
      status: run.status,
      runnerId,
      buyerId,
      startedAt: now,
      stopCount: stops.length,
      storeIds,
      ...(requestId !== undefined ? { requestId } : {}),
    };
    await this.env.ARCHIVE_QUEUE.send(serializeEvent(runStarted)).catch((error: unknown) => {
      console.error("run.started archive send failed", error);
    });

    // Checkout accepted: the buyer is committed; the Run takes over.
    const accepted: ServerEvent = {
      type: "checkout.accepted",
      cartId: state.cartId,
      runId,
      floorRateKobo,
      delivery: command.delivery,
    };
    broadcast(this.ctx, accepted);

    // Retirement: every product is sold; the cart is checked out. Archive
    // snapshots go on the queue, then DO storage is deleted (ADR-0010).
    const retiredAt = now;
    for (const entry of state.entries) {
      const productStub = this.env.PRODUCT_DO.get(this.env.PRODUCT_DO.idFromName(entry.product.id));
      await productStub
        .fetch(
          internalPost(
            "/retire",
            { reason: "sold" } satisfies RetireProductRequest,
            correlation.headers !== undefined ? new Headers(correlation.headers) : undefined,
          ),
        )
        .catch(() => {
          // A failed notification leaves the product to its own TTL clock;
          // the cart record below remains the source of truth for the sale.
        });
    }
    const cartRetired: ServerEvent = {
      type: "cart.retired",
      cartId: state.cartId,
      market: state.market,
      reason: "checked-out",
      retiredAt,
      snapshot: { ...this.cartView(), status: "checked-out" },
      ...(requestId !== undefined ? { requestId } : {}),
    };
    broadcast(this.ctx, cartRetired);
    await this.env.ARCHIVE_QUEUE.send(serializeEvent(cartRetired));
    // Doctrine (ADR-0010): retirement = archive snapshot + delete DO storage.
    // The tombstone is the ONE exception — a minimal receipt so a checkout
    // retry can recover its runId (409 cart-already-checked-out) instead of a
    // bare 404. It is not retained cart state and can never seed a second run
    // (RunDO seed idempotency remains the second line of defense).
    await this.ctx.storage.deleteAll();
    const tombstone: CartTombstone = { retired: true, cartId: state.cartId, runId, retiredAt };
    await this.ctx.storage.put(TOMBSTONE_KEY, tombstone);
    this.tombstone = tombstone;
    return jsonResponse(accepted);
  }

  private async marketConfig(
    marketStub: DurableObjectStub,
    correlation: { headers?: Record<string, string> } = {},
  ): Promise<MarketConfig | Response> {
    return fetchInternal(marketStub, new Request("http://do/config", correlation), MarketConfigSchema);
  }

  private paymentsBaseUrl(): string {
    return (this.env.PAYMENTS_URL ?? PAYMENTS_URL_DEFAULT).replace(/\/+$/, "");
  }

  /**
   * Payment gate check: the payments worker's hold for `paymentRef` must
   * exist, be `held`, belong to this cart and buyer, and cover the checkout
   * total. Returns null on pass; a refusal/502 Response on failure.
   */
  private async verifyCheckoutHold(
    paymentRef: string,
    context: { cartId: string; buyerId: string; checkoutTotalKobo: number },
  ): Promise<Response | null> {
    let upstream: Response;
    try {
      upstream = await fetch(`${this.paymentsBaseUrl()}/payments/holds/${encodeURIComponent(paymentRef)}`);
    } catch {
      return errorResponse(502, "payments-unavailable", "the payments service did not respond; checkout is not completed");
    }
    if (upstream.status === 404) {
      return refusal(
        "payment-hold-not-found",
        "no confirmed hold exists for this paymentRef — confirm the charge at /payments/charges/confirm first",
      );
    }
    if (!upstream.ok) {
      return errorResponse(502, "payments-unavailable", `the payments service answered ${upstream.status}`);
    }
    let raw: unknown;
    try {
      raw = await upstream.json();
    } catch {
      return errorResponse(502, "bad-payments-response", "the hold read was not JSON");
    }
    const hold = PaymentHoldViewSchema.safeParse(raw);
    if (!hold.success) {
      return errorResponse(502, "bad-payments-response", "the hold read failed validation");
    }
    if (hold.data.status !== "held") {
      return refusal("payment-hold-not-held", `the hold is ${hold.data.status}; checkout requires a held hold`);
    }
    if (hold.data.cartId !== context.cartId) {
      return refusal("payment-hold-mismatch", "the hold belongs to a different cart");
    }
    if (hold.data.buyerId !== context.buyerId) {
      return refusal("payment-hold-mismatch", "the hold belongs to a different buyer");
    }
    if (hold.data.amountKobo < context.checkoutTotalKobo) {
      return refusal(
        "payment-hold-insufficient",
        `the hold covers ${hold.data.amountKobo} kobo; the checkout total is ${context.checkoutTotalKobo} kobo`,
      );
    }
    return null;
  }

  /** Bind a verified hold to its run (post-seed). Failures are logged, never checkout-blocking. */
  private async bindHoldToRun(paymentRef: string, runId: string): Promise<void> {
    try {
      const bound = await fetch(`${this.paymentsBaseUrl()}/payments/holds/${encodeURIComponent(paymentRef)}/bind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      if (!bound.ok) {
        console.error(
          JSON.stringify({ event: "payment.hold_bind_failed", paymentRef, runId, status: bound.status }),
        );
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "payment.hold_bind_failed", paymentRef, runId, error: String(error) }));
    }
  }

  /**
   * Resolve the trip's geography from the market config: runner start (market
   * center) → seller stops in order → delivery. Stops and the delivery always
   * resolve to the center as a last resort so the map and routing degrade,
   * never fail. Returns null when the market has no geo table at all.
   */
  private resolveGeography(
    stopOrder: Array<{ sellerName: string; exchangePoint: string }>,
    command: CheckoutRequested,
    config: MarketConfig,
  ): { waypoints: GeoPointValue[]; stopLocations: GeoPointValue[]; deliveryLocation: GeoPointValue } | null {
    const geo = config.geo;
    if (!geo) return null;
    const center: GeoPointValue = geo.center;

    const findPoint = (points: GeoPoint[], name: string): GeoPointValue | undefined =>
      points.find((point) => point.name === name) ??
      points.find((point) => point.name.toLowerCase() === name.toLowerCase());

    const stopLocations = stopOrder.map((stop) => findPoint(geo.exchangePoints, stop.exchangePoint) ?? center);

    let deliveryLocation: GeoPointValue;
    if (command.delivery.kind === "muster-point") {
      deliveryLocation = findPoint(geo.musterPoints, command.delivery.name) ?? center;
    } else {
      deliveryLocation = plusCodeToLocation(command.delivery.plusCode, center) ?? center;
    }

    return {
      waypoints: [center, ...stopLocations, deliveryLocation],
      stopLocations,
      deliveryLocation,
    };
  }

  /** The wire projection of this cart. */
  private cartView(): Cart {
    const state = this.state;
    return {
      id: state.cartId ?? cartIdForBuyer(state.market ?? "unknown", state.buyerId ?? "buyer:anonymous"),
      market: state.market ?? "unknown",
      products: state.entries.map((entry) => entry.product),
      firstAcceptedAt: state.firstAcceptedAt ?? 0,
      acceptanceCount: state.acceptanceCount,
      deadline: state.deadline ?? 0,
      status: state.status,
    };
  }

  async alarm(): Promise<void> {
    // Doctrine: load state from storage at the start of the alarm.
    this.state =
      (await this.ctx.storage.get<CartState>(STATE_KEY)) ?? { entries: [], acceptanceCount: 0, status: "open" };
    if (this.state.status !== "open" || this.state.deadline === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = this.now();
    if (now < this.state.deadline) {
      await this.ctx.storage.put(STATE_KEY, this.state);
      await this.ctx.storage.setAlarm(this.state.deadline);
      return;
    }

    // Deadline lapsed: the whole cart retires atomically (ADR-0003). Retire
    // every product object first — inside this single alarm handler — so no
    // product is resurrectable afterwards.
    this.state.status = "retired";
    const retiredAt = now;
    const retiredProducts = this.state.entries.map((entry) => ({ ...entry.product, status: "retired" as const }));

    const retireRequest: RetireProductRequest = { reason: "cart-retired" };
    for (const entry of this.state.entries) {
      const productStub = this.env.PRODUCT_DO.get(this.env.PRODUCT_DO.idFromName(entry.product.id));
      await productStub.fetch(internalPost("/retire", retireRequest)).catch(() => {
        // A failed notification leaves the product to its own TTL clock; the
        // cart snapshot below still records it as retired.
      });
    }

    const cartRetired: ServerEvent = {
      type: "cart.retired",
      cartId: this.state.cartId ?? "unknown",
      market: this.state.market ?? "unknown",
      reason: "deadline-expired",
      retiredAt,
      snapshot: {
        id: this.state.cartId ?? "unknown",
        market: this.state.market ?? "unknown",
        products: retiredProducts,
        firstAcceptedAt: this.state.firstAcceptedAt ?? 0,
        acceptanceCount: this.state.acceptanceCount,
        deadline: this.state.deadline,
        status: "retired",
      },
    };
    broadcast(this.ctx, cartRetired);
    await this.env.ARCHIVE_QUEUE.send(serializeEvent(cartRetired));
    // Expiry retirement deletes cart state (ADR-0010) — but never a prior
    // checkout tombstone: that receipt belongs to the checked-out cart and is
    // what lets a lost checkout retry recover its runId.
    const tombstone = (await this.ctx.storage.get<CartTombstone>(TOMBSTONE_KEY)) ?? null;
    await this.ctx.storage.deleteAll();
    if (tombstone) await this.ctx.storage.put(TOMBSTONE_KEY, tombstone);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    handleWebSocketMessage(ws, message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    handleWebSocketClose(ws, code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    handleWebSocketError(ws);
  }
}
