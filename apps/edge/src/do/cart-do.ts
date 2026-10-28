import { DurableObject } from "cloudflare:workers";
import { TelemetryReporter } from "./telemetry.js";
import { cartDeadline, floorRate, plusCodeToLocation } from "@market-runs/domain";
import type { Cart, CartQuoteRequest, CheckoutRequested, Delivery, GeoPointValue, PaymentHoldView, Product, ServerEvent } from "@market-runs/proto";
import { CartQuoteRequestSchema, PaymentHoldViewSchema } from "@market-runs/proto";
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
import type { TripRoute } from "./routing.js";
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

interface StopOrderEntry {
  sellerName: string;
  exchangePoint: string;
  storeId?: string;
  sellerParticipantId?: string;
}

interface CartGeography {
  waypoints: GeoPointValue[];
  stopLocations: GeoPointValue[];
  deliveryLocation: GeoPointValue;
}

interface CartPricing {
  config: MarketConfig;
  stopOrder: StopOrderEntry[];
  geography: CartGeography | null;
  trip: TripRoute | null;
  goodsKobo: number;
  floorRateKobo: number;
}

interface StoredCartQuote extends CartPricing {
  quoteId: string;
  delivery: Delivery;
  expiresAt: number;
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
  /** Latest short-lived routed quote; invalidated whenever the cart changes. */
  quote?: StoredCartQuote;
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
  private telemetry: TelemetryReporter;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.telemetry = new TelemetryReporter(ctx, "CartDO");
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

    const objectName = this.ctx.id.name ?? "unknown";
    this.telemetry.beat(this.env, objectName, this.state.market);
    if (isWebSocketUpgrade(request)) return acceptHibernatedWebSocket(this.ctx, request);
    if (request.method === "GET" && path === "/ops/telemetry") return this.telemetry.snapshot(this.env, objectName, this.state.market);

    if (request.method === "POST" && path === "/accept") {
      const parsed = await parseInternal(request, CartAppendRequestSchema);
      if (!parsed.ok) return parsed.response;
      return internalErrorGuard(() => this.acceptProduct(parsed.data));
    }
    if (request.method === "POST" && path === "/quote") {
      const parsed = await parseInternal(request, CartQuoteRequestSchema);
      if (!parsed.ok) return parsed.response;
      return internalErrorGuard(() => this.quote(parsed.data, request.headers.get("x-participant-id") ?? undefined));
    }
    if (request.method === "GET" && path === "/delivery-options") {
      return internalErrorGuard(() => this.deliveryOptions());
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
    delete this.state.quote;
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.ctx.storage.setAlarm(this.state.deadline);

    const event: ServerEvent = { type: "cart.updated", cart: this.cartView() };
    broadcast(this.ctx, this.env,event);
    return jsonResponse(event);
  }

  /** Authenticated collection quote: no holds, charges, runs, or retirement side effects. */
  private async quote(input: CartQuoteRequest, buyerId?: string): Promise<Response> {
    const state = this.state;
    if (!state.cartId || !state.market) return notFound("cart is empty or retired");
    if (state.status !== "open") return conflict(`cart is ${state.status}; quoting is refused`);
    if (state.buyerId !== undefined && buyerId !== undefined && state.buyerId !== buyerId) {
      return conflict(`cart ${state.cartId} belongs to ${state.buyerId}; ${buyerId} cannot quote it`);
    }
    if (state.deadline === undefined || this.now() >= state.deadline) {
      return refusal("cart-deadline", "the cart deadline has lapsed; a new quote cannot be issued");
    }
    const pricing = await this.calculatePricing(input.delivery);
    if (pricing instanceof Response) return pricing;
    const quoteId = crypto.randomUUID();
    const expiresAt = Math.min(this.now() + 5 * 60_000, state.deadline);
    this.state.quote = { quoteId, delivery: input.delivery, expiresAt, ...pricing };
    await this.ctx.storage.put(STATE_KEY, this.state);
    return jsonResponse({
      quoteId,
      cartId: state.cartId,
      delivery: input.delivery,
      goodsKobo: pricing.goodsKobo,
      deliveryKobo: pricing.floorRateKobo,
      totalKobo: pricing.goodsKobo + pricing.floorRateKobo,
      expiresAt,
    });
  }

  /** Registered choices only — the client never invents a muster-point name. */
  private async deliveryOptions(): Promise<Response> {
    if (!this.state.market) return notFound("cart is empty or retired");
    const marketStub = this.env.MARKET_DO.get(this.env.MARKET_DO.idFromName(this.state.market));
    const config = await this.marketConfig(marketStub);
    if (config instanceof Response) return config;
    return jsonResponse({ musterPoints: config.geo?.musterPoints.map((point) => point.name) ?? [] });
  }

  /** The one CartDO pricing path shared by quote and checkout. */
  private async calculatePricing(delivery: Delivery): Promise<CartPricing | Response> {
    const state = this.state;
    if (!state.market) return notFound("cart is empty or retired");
    const marketStub = this.env.MARKET_DO.get(this.env.MARKET_DO.idFromName(state.market));
    const config = await this.marketConfig(marketStub);
    if (config instanceof Response) return config;

    const stopOrder: StopOrderEntry[] = [];
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

    const geography = this.resolveGeography(stopOrder, delivery, config);
    if (!geography && this.env.ALLOW_HEADER_AUTH !== "true") {
      return refusal("location-unresolved", "Checkout geography is unresolved. Ops must configure the market center, every exchange point, and this buyer destination; the market center is never a fallback.");
    }
    const trip = geography && this.env.OSRM_BASE_URL ? await routeTrip(this.env.OSRM_BASE_URL, geography.waypoints) : null;
    const floorRateKobo = floorRate({
      ...config.floorRate,
      ...(trip ? { distanceMeters: trip.distanceMeters, estimatedDurationMs: trip.durationSeconds * 1000 } : {}),
    });
    return {
      config,
      stopOrder,
      geography,
      trip,
      goodsKobo: state.entries.reduce((sum, entry) => sum + entry.product.priceKobo, 0),
      floorRateKobo,
    };
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

    let pricing: CartPricing;
    if (command.quoteId) {
      const quoted = state.quote;
      if (!quoted || quoted.quoteId !== command.quoteId || JSON.stringify(quoted.delivery) !== JSON.stringify(command.delivery)) {
        return refusal("quote-mismatch", "the quote does not match this cart and delivery; request a fresh quote");
      }
      if (this.now() >= quoted.expiresAt) {
        return refusal("quote-expired", "the routed quote expired; request a fresh quote before checkout");
      }
      pricing = quoted;
    } else {
      const calculated = await this.calculatePricing(command.delivery);
      if (calculated instanceof Response) return calculated;
      pricing = calculated;
    }
    const { config, stopOrder, geography, trip, floorRateKobo } = pricing;

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

    // Payment gate (Env.PAYMENTS_REQUIRED, dev default OFF): one or more holds
    // belonging to this cart and buyer must cover goods + delivery. Additional
    // references are exact top-ups after a reroute/shortfall, never re-charges
    // of an existing hold. The gate only reads and binds verified holds.
    const paymentRefs = [...new Set([...(command.paymentRef ? [command.paymentRef] : []), ...(command.paymentRefs ?? [])])];
    if (paymentsRequired(this.env.PAYMENTS_REQUIRED)) {
      if (paymentRefs.length === 0) {
        return refusal(
          "payment-required",
          "checkout requires a confirmed payment hold — confirm the charge and pass its txRef as paymentRef",
        );
      }
      const checkoutTotalKobo = legs.reduce((sum, leg) => sum + leg.amountKobo, 0) + floorRateKobo;
      let heldKobo = 0;
      for (const paymentRef of paymentRefs) {
        const hold = await this.verifyCheckoutHold(paymentRef, { cartId: state.cartId, buyerId });
        if (hold instanceof Response) return hold;
        heldKobo += hold.amountKobo;
      }
      if (heldKobo < checkoutTotalKobo) {
        const message = `the holds cover ${heldKobo} kobo; the checkout total is ${checkoutTotalKobo} kobo`;
        return errorResponse(409, "payment-hold-insufficient", message, {
          refusal: message,
          heldKobo,
          requiredKobo: checkoutTotalKobo,
          shortfallKobo: checkoutTotalKobo - heldKobo,
        });
      }
    }

    const runId = runIdForCart(state.cartId);
    const run = {
      id: runId,
      market: state.market,
      status: (this.env.ALLOW_HEADER_AUTH === "true" ? "assigned" : "unassigned") as "assigned" | "unassigned",
      floorRateKobo,
      delivery: command.delivery,
      receiver: command.receiver,
      delegatedByParticipantId: buyerId,
      stops,
      handoffs: [],
      route: {
        distanceMeters: trip?.distanceMeters ?? config.floorRate.distanceMeters,
        durationSeconds: trip?.durationSeconds ?? config.floorRate.estimatedDurationMs / 1000,
        ...(trip?.geometry ? { geometry: trip.geometry } : {}),
        ...(geography ? { destination: geography.deliveryLocation } : {}),
      },
    };

    // Production runs wait for an atomic pool claim. The explicit header-auth
    // demo posture retains its seeded internal runner so existing rehearsals
    // can drive the complete trip without casting a separate pool member.
    const runnerId = this.env.ALLOW_HEADER_AUTH === "true" ? "runner:internal" : null;
    const sellerParticipantIds = [...new Set(state.entries.flatMap((entry) => entry.product.sellerParticipantId ? [entry.product.sellerParticipantId] : []))];
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
          ...(sellerParticipantIds.length > 0 ? { sellerParticipantIds } : {}),
        },
        correlation.headers !== undefined ? new Headers(correlation.headers) : undefined,
      ),
    );
    if (!seeded.ok) {
      return new Response(await seeded.text(), { status: 502, headers: { "content-type": "application/json" } });
    }
    const seedReceipt = await seeded.json() as { deliveryCode?: string; deliveryCodeExpiresAt?: number };
    if (!seedReceipt.deliveryCode || seedReceipt.deliveryCodeExpiresAt === undefined) {
      return errorResponse(502, "bad-run-response", "run did not issue a delivery code");
    }

    // Bind every contributing hold to the run (gated checkouts only). A missed
    // bind is recoverable by txRef and never changes the checkout outcome.
    if (paymentsRequired(this.env.PAYMENTS_REQUIRED)) {
      for (const paymentRef of paymentRefs) await this.bindHoldToRun(paymentRef, runId);
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
      ...(sellerParticipantIds.length > 0 ? { sellerParticipantIds } : {}),
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
      receiver: command.receiver,
      buyerId,
      runnerId,
    };
    // The broadcast and notification pipeline never carry the raw delivery code.
    broadcast(this.ctx, this.env, accepted);

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
    broadcast(this.ctx, this.env,cartRetired);
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
    return jsonResponse({
      ...accepted,
      deliveryCode: seedReceipt.deliveryCode,
      deliveryCodeExpiresAt: seedReceipt.deliveryCodeExpiresAt,
    });
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

  /** Read one verified hold; aggregate coverage is checked across all references. */
  private async verifyCheckoutHold(
    paymentRef: string,
    context: { cartId: string; buyerId: string },
  ): Promise<PaymentHoldView | Response> {
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
    return hold.data;
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
   * center) → seller stops in order → delivery. Unknown names/codes fail closed:
   * the center is a short-Plus-Code reference, never an enforcement fallback.
   */
  private resolveGeography(
    stopOrder: Array<{ sellerName: string; exchangePoint: string }>,
    delivery: Delivery,
    config: MarketConfig,
  ): CartGeography | null {
    const geo = config.geo;
    if (!geo) return null;
    const center: GeoPointValue = geo.center;

    const findPoint = (points: GeoPoint[], name: string): GeoPointValue | undefined =>
      points.find((point) => point.name === name) ??
      points.find((point) => point.name.toLowerCase() === name.toLowerCase());

    const stopLocations = stopOrder.map((stop) => findPoint(geo.exchangePoints, stop.exchangePoint));
    if (stopLocations.some((point) => point === undefined)) return null;

    const deliveryLocation = delivery.kind === "muster-point"
      ? findPoint(geo.musterPoints, delivery.name)
      : plusCodeToLocation(delivery.plusCode, center);
    if (!deliveryLocation) return null;

    return {
      waypoints: [center, ...stopLocations as GeoPointValue[], deliveryLocation],
      stopLocations: stopLocations as GeoPointValue[],
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
      ...(state.buyerId ? { buyerId: state.buyerId } : {}),
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
        ...(this.state.buyerId ? { buyerId: this.state.buyerId } : {}),
      },
    };
    broadcast(this.ctx, this.env, cartRetired);
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
    this.telemetry.beat(this.env, this.ctx.id.name ?? "unknown", this.state.market, true);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    handleWebSocketClose(ws, code, reason);
    this.telemetry.beat(this.env, this.ctx.id.name ?? "unknown", this.state.market, true);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    handleWebSocketError(ws);
  }
}
