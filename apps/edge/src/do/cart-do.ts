import { DurableObject } from "cloudflare:workers";
import { cartDeadline, floorRate } from "@market-runs/domain";
import type { Cart, CheckoutRequested, Product, ServerEvent } from "@market-runs/proto";
import type { Env } from "../env.js";
import {
  STATE_KEY,
  acceptHibernatedWebSocket,
  broadcast,
  conflict,
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
} from "../protocol.js";
import {
  CartAppendRequestSchema,
  CloseGateResponseSchema,
  MarketConfigSchema,
  cartIdForMarket,
  fetchInternal,
  internalPost,
  runIdForCart,
  type CartAppendRequest,
  type MarketConfig,
  type RetireProductRequest,
} from "../internal.js";

interface CartEntry {
  product: Product;
  /** The product's market, recorded at acceptance so the one-market rule is checkable. */
  market: string;
}

interface CartState {
  cartId?: string;
  market?: string;
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
 * market until participant identity lands on the wire. On expiry the whole
 * cart retires atomically — every unbought product retires with it and none
 * is ever resurrected.
 */
export class CartDO extends DurableObject<Env> {
  private state: CartState = { entries: [], acceptanceCount: 0, status: "open" };

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
      return internalErrorGuard(() => this.checkout(command));
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
  private async checkout(command: CheckoutRequested): Promise<Response> {
    const state = this.state;
    if (!state.cartId || !state.market) return notFound("cart is empty or retired");
    if (command.cartId !== state.cartId) {
      return conflict(`checkout.requested addresses cart ${command.cartId}, not this cart`);
    }
    if (state.status !== "open") return conflict(`cart is ${state.status}; checkout is refused`);
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
    const gate = await fetchInternal(marketStub, new Request("http://do/close-gate"), CloseGateResponseSchema);
    if (gate instanceof Response) return gate;
    if (!gate.ok) {
      return refusal("market-close-gate", gate.refusal ?? "the market is too close to closing for this trip");
    }

    const config = await this.marketConfig(marketStub);
    if (config instanceof Response) return config;

    // MVP: internal runners at the floor rate only (ADR-0013).
    const floorRateKobo = floorRate(config.floorRate);

    // Seed stops grouped by seller exchange point, preserving acceptance order.
    const stopOrder: Array<{ sellerName: string; exchangePoint: string }> = [];
    for (const entry of state.entries) {
      const product = entry.product;
      if (!stopOrder.some((stop) => stop.sellerName === product.sellerName && stop.exchangePoint === product.exchangePoint)) {
        stopOrder.push({ sellerName: product.sellerName, exchangePoint: product.exchangePoint });
      }
    }
    const stops = stopOrder.map((stop, index) => ({
      sellerName: stop.sellerName,
      exchangePoint: stop.exchangePoint,
      shopItems: state.entries
        .filter((entry) => entry.product.sellerName === stop.sellerName && entry.product.exchangePoint === stop.exchangePoint)
        .map((entry) => entry.product.shopItem),
      status: (index === 0 ? "next" : "upcoming") as "next" | "upcoming",
    }));

    // Settlement legs: per-seller goods totals, in kobo, integers only.
    const legs: Array<{ sellerId: string; amountKobo: number }> = [];
    for (const entry of state.entries) {
      const leg = legs.find((candidate) => candidate.sellerId === entry.product.sellerName);
      if (leg) leg.amountKobo += entry.product.priceKobo;
      else legs.push({ sellerId: entry.product.sellerName, amountKobo: entry.product.priceKobo });
    }

    const runId = runIdForCart(state.cartId);
    const run = {
      id: runId,
      market: state.market,
      status: "assigned" as const,
      floorRateKobo,
      delivery: command.delivery,
      stops,
      handoffs: [],
    };

    // Create the Run by idFromName on RUN_DO and seed it.
    const runStub = this.env.RUN_DO.get(this.env.RUN_DO.idFromName(runId));
    const seeded = await runStub.fetch(
      internalPost("/seed", { run, legs, settlement: config.settlement }),
    );
    if (!seeded.ok) {
      return new Response(await seeded.text(), { status: 502, headers: { "content-type": "application/json" } });
    }

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
        .fetch(internalPost("/retire", { reason: "sold" } satisfies RetireProductRequest))
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
    };
    broadcast(this.ctx, cartRetired);
    await this.env.ARCHIVE_QUEUE.send(serializeEvent(cartRetired));
    await this.ctx.storage.deleteAll();
    return jsonResponse(accepted);
  }

  private async marketConfig(marketStub: DurableObjectStub): Promise<MarketConfig | Response> {
    return fetchInternal(marketStub, new Request("http://do/config"), MarketConfigSchema);
  }

  /** The wire projection of this cart. */
  private cartView(): Cart {
    const state = this.state;
    return {
      id: state.cartId ?? cartIdForMarket(state.market ?? "unknown"),
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
    await this.ctx.storage.deleteAll();
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
