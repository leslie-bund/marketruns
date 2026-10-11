import { DurableObject } from "cloudflare:workers";
import { productTtl } from "@market-runs/domain";
import type {
  NegotiationPriceAdjusted,
  Product,
  ProductAccepted,
  ServerEvent,
} from "@market-runs/proto";
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
  serializeEvent,
} from "../protocol.js";
import {
  IntentLookupResponseSchema,
  OfferProductRequestSchema,
  RetireProductRequestSchema,
  cartIdForMarket,
  fetchInternal,
  internalPost,
  type CartAppendRequest,
  type OfferProductRequest,
  type RetireProductRequest,
} from "../internal.js";

interface PriceMove {
  by: "buyer" | "seller";
  priceKobo: number;
  at: number;
}

interface ProductState {
  product?: Product;
  /** The market of the intent this product answers; determines its cart. */
  market?: string;
  intentExpiresAt?: number;
  priceHistory: PriceMove[];
  retired: boolean;
  /** Deterministic-time seam: epoch offset added to Date.now(). 0 in production. */
  timeOffsetMs?: number;
}

/**
 * Per product: the one-to-one negotiation (ADR-0002), accept-once, and
 * retirement. The object is single-threaded, so accept-once is atomic —
 * the first accept transitions to "accepted" and every later accept is a 409.
 */
export class ProductDO extends DurableObject<Env> {
  private state: ProductState = { priceHistory: [], retired: false };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private now(): number {
    return Date.now() + (this.state.timeOffsetMs ?? 0);
  }

  async fetch(request: Request): Promise<Response> {
    // Doctrine: load state from storage at the start of every fetch.
    this.state =
      (await this.ctx.storage.get<ProductState>(STATE_KEY)) ?? { priceHistory: [], retired: false };
    const url = new URL(request.url);
    const path = url.pathname.endsWith("/") && url.pathname.length > 1 ? url.pathname.slice(0, -1) : url.pathname;

    if (isWebSocketUpgrade(request)) return acceptHibernatedWebSocket(this.ctx);

    if (request.method === "POST" && path === "/offer") {
      const parsed = await parseInternal(request, OfferProductRequestSchema);
      if (!parsed.ok) return parsed.response;
      return internalErrorGuard(() => this.offer(parsed.data));
    }
    if (request.method === "POST" && path === "/price") {
      const parsed = await parseClientCommand(request);
      const command = expectCommand(parsed, "negotiation.price-adjusted");
      if (command instanceof Response) return command;
      return internalErrorGuard(() => this.adjustPrice(command));
    }
    if (request.method === "POST" && path === "/accept") {
      const parsed = await parseClientCommand(request);
      const command = expectCommand(parsed, "product.accepted");
      if (command instanceof Response) return command;
      return internalErrorGuard(() => this.accept(command));
    }
    if (request.method === "POST" && path === "/retire") {
      const parsed = await parseInternal(request, RetireProductRequestSchema);
      if (!parsed.ok) return parsed.response;
      return internalErrorGuard(() => this.retire(parsed.data, this.now()));
    }
    if (request.method === "GET" && path === "/") {
      const product = this.state.product;
      if (!product || this.state.retired) return notFound("product is retired or unknown — products are never resurrected");
      const event: ServerEvent = { type: "product.offered", product };
      return jsonResponse(event);
    }
    return notFound(`ProductDO route not found: ${request.method} ${path}`);
  }

  /** Seller offers a product in response to an intent. Dies with its intent, max 30 min (domain productTtl). */
  private async offer(data: OfferProductRequest): Promise<Response> {
    const now = this.now();
    if (this.state.retired) {
      return conflict(`product ${data.productId} is retired, never resurrected`);
    }
    if (this.state.product) {
      // Idempotent replay of the same offer.
      const event: ServerEvent = { type: "product.offered", product: this.state.product };
      return jsonResponse(event);
    }

    // The intent must be live in the product's market; its expiry bounds the product's TTL.
    const marketStub = this.env.MARKET_DO.get(this.env.MARKET_DO.idFromName(data.market));
    const lookup = await fetchInternal(
      marketStub,
      new Request(`http://do/intent/${encodeURIComponent(data.intentId)}`),
      IntentLookupResponseSchema,
    );
    if (lookup instanceof Response) return lookup;
    if (!lookup.found) {
      return notFound(`intent ${data.intentId} is not open in market ${data.market}`);
    }

    const intentExpiresAt = lookup.expiresAt;
    const createdAt = now;
    const expiresAt = productTtl(createdAt, intentExpiresAt);
    const product: Product = {
      id: data.productId,
      intentId: data.intentId,
      shopItem: data.shopItem,
      quantity: data.quantity,
      unit: data.unit,
      priceKobo: data.priceKobo,
      sellerName: data.sellerName,
      exchangePoint: data.exchangePoint,
      expiresAt,
      status: "available",
    };
    this.state.product = product;
    this.state.market = data.market;
    this.state.intentExpiresAt = intentExpiresAt;
    this.state.priceHistory = [{ by: "seller", priceKobo: data.priceKobo, at: createdAt }];
    await this.ctx.storage.put(STATE_KEY, this.state);

    if (expiresAt <= now) return this.retire({ reason: "expired" }, now);
    await this.ctx.storage.setAlarm(expiresAt);

    const event: ServerEvent = { type: "product.offered", product };
    broadcast(this.ctx, event);
    return jsonResponse(event);
  }

  /** Either side may adjust the price (ADR-0002); the band guides, never caps. */
  private async adjustPrice(command: NegotiationPriceAdjusted): Promise<Response> {
    const product = this.requireNegotiable();
    if (product instanceof Response) return product;
    if (command.productId !== product.id) {
      return conflict(`negotiation addresses product ${command.productId}, not this product`);
    }

    if (product.status === "accepted") {
      return conflict(`product ${product.id} is already accepted — negotiation is closed`);
    }
    if (product.status !== "available" && product.status !== "negotiating") {
      return conflict(`product ${product.id} is ${product.status}; price cannot move`);
    }
    product.status = "negotiating";
    product.priceKobo = command.priceKobo;
    this.state.priceHistory.push({ by: command.by, priceKobo: command.priceKobo, at: command.at });
    await this.ctx.storage.put(STATE_KEY, this.state);

    const event: ServerEvent = {
      type: "negotiation.price-adjusted",
      productId: product.id,
      by: command.by,
      priceKobo: command.priceKobo,
      at: command.at,
    };
    broadcast(this.ctx, event);
    return jsonResponse(event);
  }

  /**
   * Accept-once. The first accept transitions the product to "accepted"
   * exactly once; every later accept is 409, and accepts after retirement are
   * rejected (products are retired, never resurrected).
   */
  private async accept(command: ProductAccepted): Promise<Response> {
    const product = this.state.product;
    if (!product || this.state.retired) {
      return notFound("product is retired or unknown — products are never resurrected");
    }
    if (command.productId !== product.id) {
      return conflict(`product.accepted addresses ${command.productId}, not this product`);
    }
    if (product.status === "accepted") {
      return conflict(`product ${product.id} was already accepted`, { code: "already-accepted" });
    }
    if (product.status !== "available" && product.status !== "negotiating") {
      return conflict(`product ${product.id} is ${product.status} and can no longer be accepted`);
    }

    const market = this.state.market;
    if (!market) return conflict("product has no market and cannot enter a cart");

    // Hold accept-once before the cross-DO cart append.
    const previousStatus = product.status;
    product.status = "accepted";
    await this.ctx.storage.put(STATE_KEY, this.state);

    const cartId = cartIdForMarket(market);
    const cartStub = this.env.CART_DO.get(this.env.CART_DO.idFromName(cartId));
    const appendBody: CartAppendRequest = { cartId, market, product };
    const append = await cartStub.fetch(internalPost("/accept", appendBody));
    if (!append.ok) {
      // The cart refused (retired/checked out): the acceptance did not
      // complete anywhere, so roll back and let the buyer retry.
      product.status = previousStatus;
      await this.ctx.storage.put(STATE_KEY, this.state);
      return conflict(`cart ${cartId} refused the product (${append.status}); acceptance rolled back`);
    }
    // The cart's cart.updated is the acceptance result for the buyer.
    return jsonResponse(await append.json());
  }

  /** Retirement: snapshot to the archive queue, tell attached sockets, delete DO storage. */
  private async retire(request: RetireProductRequest, now: number): Promise<Response> {
    const product = this.state.product;
    this.state.retired = true;
    if (product) {
      product.status = "retired";
      const event: ServerEvent = {
        type: "product.retired",
        productId: product.id,
        intentId: product.intentId,
        reason: request.reason,
        retiredAt: now,
        snapshot: product,
      };
      broadcast(this.ctx, event);
      await this.env.ARCHIVE_QUEUE.send(serializeEvent(event));
    }
    await this.ctx.storage.deleteAll();
    return jsonResponse({ retired: true, reason: request.reason });
  }

  private requireNegotiable(): Product | Response {
    const product = this.state.product;
    if (!product || this.state.retired) {
      return notFound("product is retired or unknown — products are never resurrected");
    }
    return product;
  }

  async alarm(): Promise<void> {
    // Doctrine: load state from storage at the start of the alarm.
    this.state =
      (await this.ctx.storage.get<ProductState>(STATE_KEY)) ?? { priceHistory: [], retired: false };
    const product = this.state.product;
    if (!product || this.state.retired) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = this.now();
    if (product.status === "accepted") {
      // Sold: the cart's deadline governs retirement (sold at checkout or
      // cart-retired on expiry). Nothing for the product clock to do.
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (now >= product.expiresAt) {
      // An unaccepted product dies with its intent.
      await this.retire({ reason: "expired" }, now);
      return;
    }
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.ctx.storage.setAlarm(product.expiresAt);
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
