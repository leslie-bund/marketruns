import { DurableObject } from "cloudflare:workers";
import { TelemetryReporter } from "./telemetry.js";
import { productTtl } from "@market-runs/domain";
import type {
  NegotiationPriceAdjusted,
  Product,
  ProductAccepted,
  ServerEvent,
} from "@market-runs/proto";
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
import type {
  CartAppendRequest,
  OfferProductRequest,
  RetireProductRequest,
} from "./schemas.js";
import { IntentLookupResponseSchema, OfferProductRequestSchema, RetireProductRequestSchema } from "./schemas.js";
import { fetchInternal, internalPost } from "./transport.js";
import { cartIdForBuyer } from "../config/ids.js";
import { headerAuthAllowed } from "../registry/index.js";
import { validateCaptureMedia } from "../media.js";

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
  /** The intent's buyer (when the wire carried one), for acceptance authorization and attribution. */
  intentBuyerId?: string | undefined;
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
  private telemetry: TelemetryReporter;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.telemetry = new TelemetryReporter(ctx, "ProductDO");
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

    const objectName = this.ctx.id.name ?? "unknown";
    this.telemetry.beat(this.env, objectName, this.state.market);
    if (isWebSocketUpgrade(request)) return acceptHibernatedWebSocket(this.ctx, request);
    if (request.method === "GET" && path === "/ops/telemetry") return this.telemetry.snapshot(this.env, objectName, this.state.market);

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
      // The accepting buyer's identity arrives as an internal header: the
      // product.accepted wire shape carries no buyerId (proto gap), so
      // command.ts forwards the header-resolved identity out of band
      // (ADR-0015), exactly like x-market-id on config writes.
      return internalErrorGuard(() => this.accept(command, request.headers.get("x-participant-id") ?? undefined));
    }
    if (request.method === "POST" && path === "/retire") {
      const parsed = await parseInternal(request, RetireProductRequestSchema);
      if (!parsed.ok) return parsed.response;
      return internalErrorGuard(() => this.retire(parsed.data, this.now(), request.headers.get("x-request-id") ?? undefined));
    }
    if (request.method === "GET" && path === "/") {
      const product = this.state.product;
      if (!product || this.state.retired) return notFound("product is retired or unknown — products are never resurrected");
      // The authorized read path carries the buyer attribution for the edge's
      // owner check plus the negotiation thread; it is never a public product read.
      const event: ServerEvent = {
        type: "product.offered",
        product,
        priceHistory: this.state.priceHistory,
        ...(this.state.intentBuyerId ? { buyerId: this.state.intentBuyerId } : {}),
      };
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

    const invalidMedia = await validateCaptureMedia(this.env, {
      refs: [[data.photoCaptureRef, "image"], [data.videoCaptureRef, "video"]],
      ownerId: data.sellerParticipantId,
      purpose: "product",
    });
    if (invalidMedia) return invalidMedia;

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
      ...(data.storeId !== undefined ? { storeId: data.storeId } : {}),
      ...(data.sellerParticipantId !== undefined ? { sellerParticipantId: data.sellerParticipantId } : {}),
      exchangePoint: data.exchangePoint,
      expiresAt,
      status: "available",
      ...(data.photoCaptureRef !== undefined ? { photoCaptureRef: data.photoCaptureRef } : {}),
      ...(data.videoCaptureRef !== undefined ? { videoCaptureRef: data.videoCaptureRef } : {}),
    };
    this.state.product = product;
    this.state.market = data.market;
    this.state.intentExpiresAt = intentExpiresAt;
    this.state.intentBuyerId = lookup.found ? lookup.intent.buyerId : undefined;
    this.state.priceHistory = [{ by: "seller", priceKobo: data.priceKobo, at: createdAt }];
    await this.ctx.storage.put(STATE_KEY, this.state);

    // Index the product under its intent so buyers can discover it. A failed
    // index leaves discovery stale but the product fully valid — the buyer's
    // own negotiation path still reaches it via the negotiation thread.
    await this.env.MARKET_DO
      .get(this.env.MARKET_DO.idFromName(data.market))
      .fetch(internalPost("/intent-product", { intentId: data.intentId, productId: data.productId }))
      .catch(() => undefined);

    if (expiresAt <= now) return this.retire({ reason: "expired" }, now);
    await this.ctx.storage.setAlarm(expiresAt);

    const event: ServerEvent = {
      type: "product.offered",
      product,
      ...(this.state.intentBuyerId ? { buyerId: this.state.intentBuyerId } : {}),
    };
    broadcast(this.ctx, this.env, event);
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
      ...(this.state.intentBuyerId ? { buyerId: this.state.intentBuyerId } : {}),
      ...(product.sellerParticipantId ? { sellerParticipantId: product.sellerParticipantId } : {}),
    };
    broadcast(this.ctx, this.env, event);
    return jsonResponse(event);
  }

  /**
   * Accept-once by the intent's buyer only. The first accept transitions the
   * product to "accepted" exactly once; every later accept is 409, including
   * after the original product TTL because the cart clock now owns retirement.
   *
   * The acceptance lands in the buyer's own cart (`cart:<market>:<buyerId>`):
   * the buyer identity is the header-resolved caller when present, else — only
   * in the explicit header-auth demo — the intent's recorded buyer or anonymous
   * fallback, never purely client-claimed on the accept wire. Deployed callers
   * require a buyer session. Unaccepted products also enforce their
   * expiry synchronously rather than waiting for the retirement alarm.
   */
  private async accept(command: ProductAccepted, callerBuyerId?: string): Promise<Response> {
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

    if ((callerBuyerId === undefined || callerBuyerId === "unauthenticated") && !headerAuthAllowed(this.env)) {
      return errorResponse(401, "unauthorized", "a buyer session is required to accept this product");
    }
    const buyerId = callerBuyerId ?? this.state.intentBuyerId ?? "buyer:anonymous";
    const originatingBuyerId = this.state.intentBuyerId ?? "buyer:anonymous";
    if (buyerId !== originatingBuyerId) {
      return errorResponse(403, "forbidden", "only the buyer who posted the intent can accept this product");
    }
    if (this.now() >= product.expiresAt) {
      return refusal("product-expired", `product ${product.id} expired with its intent and cannot be accepted`);
    }

    const market = this.state.market;
    if (!market) return conflict("product has no market and cannot enter a cart");

    // Hold accept-once before the cross-DO cart append.
    const previousStatus = product.status;
    product.status = "accepted";
    await this.ctx.storage.put(STATE_KEY, this.state);

    const cartId = cartIdForBuyer(market, buyerId);
    const cartStub = this.env.CART_DO.get(this.env.CART_DO.idFromName(cartId));
    const appendBody: CartAppendRequest = { cartId, market, buyerId, product };
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

  /** Retirement snapshots media references for finite archive retention, notifies sockets, then deletes DO storage. */
  private async retire(request: RetireProductRequest, now: number, requestId?: string): Promise<Response> {
    const product = this.state.product;
    if (product) {
      const cartId = product.status === "accepted" && this.state.market
        ? cartIdForBuyer(this.state.market, this.state.intentBuyerId ?? "buyer:anonymous")
        : undefined;
      product.status = "retired";
      const event: ServerEvent = {
        type: "product.retired",
        productId: product.id,
        intentId: product.intentId,
        reason: request.reason,
        retiredAt: now,
        snapshot: product,
        ...(this.state.market !== undefined ? { market: this.state.market } : {}),
        ...(this.state.intentBuyerId !== undefined ? { buyerId: this.state.intentBuyerId } : {}),
        ...(cartId !== undefined ? { cartId } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
      };
      broadcast(this.ctx, this.env,event);
      await this.env.ARCHIVE_QUEUE.send(serializeEvent(event));
    }
    this.state.retired = true;
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
