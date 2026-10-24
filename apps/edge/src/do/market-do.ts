import { DurableObject } from "cloudflare:workers";
import { INTENT_TTL_MS, marketCloseGateOk } from "@market-runs/domain";
import type { DiscoveryResponse, Intent, IntentPosted, MarketJoined, Product, ServerEvent, Store, StoreRegistered } from "@market-runs/proto";
import { ProductOfferedSchema } from "@market-runs/proto";
import type { Env } from "../config/env.js";
import {
  acceptHibernatedWebSocket,
  broadcast,
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
} from "./runtime/index.js";
import { fetchInternal } from "./transport.js";
import { STATE_KEY } from "./state.js";
import { coreRegistry } from "../registry/index.js";
import {
  IntentProductRequestSchema,
  MARKET_OPEN_WINDOW_MS,
  MarketConfigSchema,
  ModerateVocabularyRequestSchema,
  defaultMarketConfig,
  type CloseGateResponse,
  type IntentLookupResponse,
  type IntentProductRequest,
  type IntentProductsResponse,
  type MarketConfig,
  type ModerateVocabularyRequest,
  type ModerateVocabularyResponse,
} from "./schemas.js";

interface StoredIntent {
  intent: Intent;
  /** createdAt + INTENT_TTL_MS; the intent dies here. */
  expiresAt: number;
}

interface MarketState {
  marketId?: string;
  intents: StoredIntent[];
  /**
   * Products offered against each open intent, in offer order — the buyer's
   * discovery index. Populated by the ProductDO at offer time; entries for
   * expired intents are pruned on read.
   */
  intentProducts: Record<string, string[]>;
  /**
   * The market's store registry (GLOSSARY: Store). A store's shop items feed
   * the market vocabulary that scopes intents to stores (ADR-0006).
   */
  stores: Store[];
  /** Participants who joined this market (all roles). */
  members: MarketMember[];
  config?: MarketConfig;
  /** Deterministic-time seam: epoch offset added to Date.now(). 0 in production. */
  timeOffsetMs?: number;
}

interface MarketMember {
  participantId: string;
  role: "buyer" | "seller" | "runner";
  joinedAt: number;
}

/**
 * Per market zone: intents, the open/close gate, and market config (floor-rate
 * and settlement coefficients). Live state only — durable records leave at
 * retirement via the archive queue (ADR-0010).
 */
export class MarketDO extends DurableObject<Env> {
  private state: MarketState = { intents: [], intentProducts: {}, stores: [], members: [] };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private now(): number {
    return Date.now() + (this.state.timeOffsetMs ?? 0);
  }

  async fetch(request: Request): Promise<Response> {
    // Doctrine: load state from storage at the start of every fetch.
    this.state = (await this.ctx.storage.get<MarketState>(STATE_KEY)) ?? { intents: [], intentProducts: {}, stores: [], members: [] };
    this.state.intentProducts ??= {}; // storage written before the discovery index existed
    this.state.stores ??= []; // storage written before the store registry existed
    this.state.members ??= []; // storage written before membership existed
    const url = new URL(request.url);
    const path = url.pathname.endsWith("/") && url.pathname.length > 1 ? url.pathname.slice(0, -1) : url.pathname;

    if (isWebSocketUpgrade(request)) return acceptHibernatedWebSocket(this.ctx, request, { marketId: this.state.marketId });

    if (request.method === "POST" && path === "/intent") {
      const parsed = await parseClientCommand(request);
      const command = expectCommand(parsed, "intent.posted");
      if (command instanceof Response) return command;
      return internalErrorGuard(() => this.postIntent(command));
    }
    if (request.method === "POST" && path === "/store") {
      const parsed = await parseClientCommand(request);
      const command = expectCommand(parsed, "store.registered");
      if (command instanceof Response) return command;
      return internalErrorGuard(() => this.registerStore(command));
    }
    if (request.method === "POST" && path === "/join") {
      const parsed = await parseClientCommand(request);
      const command = expectCommand(parsed, "market.joined");
      if (command instanceof Response) return command;
      return internalErrorGuard(() => this.joinMarket(command));
    }
    if (request.method === "GET" && path === "/members") {
      return jsonResponse({ members: this.state.members });
    }
    if (request.method === "GET" && path === "/stores") {
      return jsonResponse({ stores: this.state.stores });
    }
    if (request.method === "GET" && path === "/vocabulary") {
      return jsonResponse({ shopItems: this.vocabulary() });
    }
    if (request.method === "GET" && path === "/intents") {
      // Scoped read: ?shopItems=Tomatoes,Peppers returns only intents whose
      // shop item a store supplies — the vocabulary is the room (ADR-0006).
      const scoped = url.searchParams.get("shopItems");
      return this.listOpenIntents(scoped ? scoped.split(",").map((item) => item.trim()).filter(Boolean) : null);
    }
    if (request.method === "GET" && path === "/discovery") {
      return internalErrorGuard(() => this.discover(url, request.headers.get("x-participant-id")));
    }
    if (request.method === "GET" && path.startsWith("/intent/") && path.endsWith("/products")) {
      const intentId = decodeURIComponent(path.slice("/intent/".length, -"/products".length));
      return this.listIntentProducts(intentId);
    }
    if (request.method === "GET" && path.startsWith("/intents/") && path.endsWith("/products")) {
      // Public scope form: /markets/:market/intents/:id/products.
      const intentId = decodeURIComponent(path.slice("/intents/".length, -"/products".length));
      return this.listIntentProducts(intentId);
    }
    if (request.method === "POST" && path === "/intent-product") {
      // ProductDO → MarketDO at offer time: index the product under its intent.
      const parsed = await parseInternal(request, IntentProductRequestSchema);
      if (!parsed.ok) return parsed.response;
      return internalErrorGuard(() => this.indexIntentProduct(parsed.data));
    }
    if (request.method === "POST" && path === "/moderate-vocabulary") {
      // Ops-only vocabulary curation (reached via the /ops/api guard).
      const parsed = await parseInternal(request, ModerateVocabularyRequestSchema);
      if (!parsed.ok) return parsed.response;
      return internalErrorGuard(() => this.moderateVocabulary(parsed.data));
    }
    if (request.method === "GET" && path.startsWith("/intent/")) {
      return this.getIntent(path.slice("/intent/".length));
    }
    if (request.method === "GET" && path === "/close-gate") {
      return internalErrorGuard(() => this.closeGate());
    }
    if (request.method === "GET" && path === "/config") {
      return internalErrorGuard(async () => jsonResponse(await this.config()));
    }
    if (request.method === "POST" && path === "/config") {
      const parsed = await parseInternal(request, MarketConfigSchema);
      if (!parsed.ok) return parsed.response;
      // Every write through this route is an ops write (the edge guards it
      // with requireOps): mark it so the dev-stage lazy rollover never
      // touches it — an ops-closed market stays closed.
      this.state.config = { ...parsed.data, opsConfigured: true };
      const headerMarket = request.headers.get("x-market-id");
      if (this.state.marketId === undefined && headerMarket !== null) this.state.marketId = headerMarket;
      await this.ctx.storage.put(STATE_KEY, this.state);
      return jsonResponse(this.state.config);
    }
    return notFound(`MarketDO route not found: ${request.method} ${path}`);
  }

  /** Buyer posts an intent. `intentId` is the client idempotency key. */
  private async postIntent(command: IntentPosted): Promise<Response> {
    const now = this.now();
    this.state.marketId ??= command.market;

    const existing = this.state.intents.find((stored) => stored.intent.id === command.intentId);
    if (existing) {
      // Idempotent replay of an already-posted intent.
      return jsonResponse({ type: "intent.recorded", intent: existing.intent } satisfies ServerEvent);
    }

    const intent: Intent = {
      id: command.intentId,
      shopItem: command.shopItem,
      quantity: command.quantity,
      unit: command.unit,
      priceBand: command.priceBand,
      market: command.market,
      createdAt: now,
      status: "open",
      ...(command.note !== undefined ? { note: command.note } : {}),
      ...(command.buyerId !== undefined ? { buyerId: command.buyerId } : {}),
    };
    this.state.intents.push({ intent, expiresAt: now + INTENT_TTL_MS });
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.scheduleAlarm();

    const event: ServerEvent = { type: "intent.recorded", intent };
    broadcast(this.ctx, this.env,event);
    return jsonResponse(event);
  }

  /** Seller registers a store when joining the market. `storeId` is the client idempotency key. */
  private async registerStore(command: StoreRegistered): Promise<Response> {
    this.state.marketId ??= command.market;

    const existing = this.state.stores.find((store) => store.id === command.storeId);
    if (existing) {
      // Idempotent replay of the same registration.
      return jsonResponse({ type: "store.recorded", store: existing } satisfies ServerEvent);
    }

    const store: Store = {
      id: command.storeId,
      market: command.market,
      name: command.name,
      sellerParticipantId: command.sellerParticipantId ?? "seller:legacy",
      exchangePoint: command.exchangePoint,
      shopItems: command.shopItems,
      joinedAt: this.now(),
    };
    this.state.stores.push(store);
    await this.ctx.storage.put(STATE_KEY, this.state);

    const event: ServerEvent = { type: "store.recorded", store };
    broadcast(this.ctx, this.env,event);
    return jsonResponse(event);
  }

  /**
   * A participant joins the market (idempotent per participant). Membership
   * also upserts the global markets index in KV so the zone becomes
   * discoverable in the market list.
   */
  private async joinMarket(command: MarketJoined): Promise<Response> {
    this.state.marketId ??= command.market;
    const now = this.now();
    if (!this.state.members.some((member) => member.participantId === command.participantId)) {
      this.state.members.push({ participantId: command.participantId, role: command.role, joinedAt: now });
      await this.ctx.storage.put(STATE_KEY, this.state);
    }
    await this.upsertMarketsIndex(command.market).catch(() => undefined); // index heals on next join

    const event: ServerEvent = {
      type: "market.member-recorded",
      market: command.market,
      participantId: command.participantId,
      role: command.role,
      joinedAt: now,
    };
    broadcast(this.ctx, this.env,event);
    return jsonResponse(event);
  }

  /** Join heals a missing registry row without overwriting an existing market's schedule. */
  private async upsertMarketsIndex(market: string): Promise<void> {
    const registry = coreRegistry(this.env);
    const exists = (await registry.listMarkets()).some((entry) => entry.id.toLowerCase() === market.toLowerCase());
    if (!exists) await registry.upsertMarket({ id: market, name: market, opensAt: "08:00", closesAt: "18:00" });
  }

  /** The market's item vocabulary: the union of every store's shop items (ADR-0006 — grown, not governed). */
  private vocabulary(): string[] {
    const items = new Set<string>();
    for (const store of this.state.stores) {
      for (const item of store.shopItems) items.add(item);
    }
    return [...items].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Ops vocabulary moderation (ADR-0006: the platform curates normalization
   * and synonyms, not a canon). `remove` deletes the item from every store's
   * shop items; `rename` rewrites it in place, deduping when the target is
   * already listed by the same store. Matching is case-insensitive — the same
   * semantics as the /intents scope filter. A store that loses its last shop
   * item stays registered; it simply stops matching intents.
   *
   * No broadcast: the proto ServerEvent union has no vocabulary/store-update
   * event and proto is not edited here — readers re-fetch /vocabulary.
   */
  private async moderateVocabulary(data: ModerateVocabularyRequest): Promise<Response> {
    const needle = (data.action === "remove" ? data.item : data.from).toLowerCase();
    const affectedStores: ModerateVocabularyResponse["affectedStores"] = [];
    for (const store of this.state.stores) {
      const next: string[] = [];
      let changed = false;
      for (let i = 0; i < store.shopItems.length; i += 1) {
        const item = store.shopItems[i]!;
        if (item.toLowerCase() !== needle) {
          next.push(item);
          continue;
        }
        if (data.action === "remove") {
          changed = true;
          continue;
        }
        const replacement = data.to;
        if (replacement === item) {
          next.push(item); // already canonical here — nothing to rewrite
          continue;
        }
        changed = true;
        // Dedupe: drop the rewrite when the store already lists the target
        // (earlier in the rebuilt list or later in the original one).
        const listed =
          next.some((kept) => kept.toLowerCase() === replacement.toLowerCase()) ||
          store.shopItems.some((other, j) => j > i && other.toLowerCase() === replacement.toLowerCase());
        if (!listed) next.push(replacement);
      }
      if (!changed) continue;
      store.shopItems = next;
      affectedStores.push({ id: store.id, name: store.name });
    }
    if (affectedStores.length > 0) await this.ctx.storage.put(STATE_KEY, this.state);
    const body: ModerateVocabularyResponse = { vocabulary: this.vocabulary(), affectedStores };
    return jsonResponse(body);
  }

  /** Open, unexpired intents — optionally scoped to the shop items a store supplies. */
  private listOpenIntents(shopItems: string[] | null): Response {
    const now = this.now();
    const scope = shopItems === null ? null : new Set(shopItems.map((item) => item.toLowerCase()));
    const intents = this.state.intents
      .filter((stored) => stored.expiresAt > now)
      .map((stored) => stored.intent)
      .filter((intent) => scope === null || scope.has(intent.shopItem.toLowerCase()));
    return jsonResponse({ intents });
  }

  /**
   * The filtered discovery read (proto/discovery.ts): open intents scoped to
   * the caller — `?shopItems=` is the seller scope (the store's items, the
   * same vocabulary match as /intents — ADR-0006) and `?buyerId=` is the
   * buyer scope, falling back to the forwarded participant identity header
   * (ADR-0015). Both filters apply when both are given. Each intent carries
   * its live products inline, so clients never fan out per intent. A
   * scope-less call returns nothing: discovery is the filtered pathway.
   */
  private async discover(url: URL, headerBuyerId: string | null): Promise<Response> {
    const scoped = url.searchParams.get("shopItems");
    const shopItems = scoped === null ? null : scoped.split(",").map((item) => item.trim()).filter(Boolean);
    const buyerId = url.searchParams.get("buyerId") || headerBuyerId;
    if ((shopItems === null || shopItems.length === 0) && !buyerId) {
      return jsonResponse({ intents: [] } satisfies DiscoveryResponse);
    }
    const now = this.now();
    const scope = shopItems === null || shopItems.length === 0 ? null : new Set(shopItems.map((item) => item.toLowerCase()));
    const intents = this.state.intents
      .filter((stored) => stored.expiresAt > now)
      .map((stored) => stored.intent)
      .filter(
        (intent) =>
          (scope === null || scope.has(intent.shopItem.toLowerCase())) &&
          (buyerId === null || intent.buyerId === buyerId),
      );
    const entries = await Promise.all(
      intents.map(async (intent) => ({ intent, products: await this.liveProducts(intent.id) })),
    );
    return jsonResponse({ intents: entries } satisfies DiscoveryResponse);
  }

  /**
   * The intent's live products, read fresh from their ProductDOs (statuses
   * stay current; retired products 404 and drop out). Server-side fan-out,
   * bounded by the caller's scope — the client makes the one discovery call.
   */
  private async liveProducts(intentId: string): Promise<Product[]> {
    const ids = this.state.intentProducts[intentId] ?? [];
    const products = await Promise.all(
      ids.map(async (id) => {
        const stub = this.env.PRODUCT_DO.get(this.env.PRODUCT_DO.idFromName(id));
        const result = await fetchInternal(stub, new Request("http://do/"), ProductOfferedSchema).catch(() => null);
        if (result === null || result instanceof Response) return null;
        return result.product;
      }),
    );
    return products.filter((product): product is Product => product !== null);
  }

  /** Internal: ProductDO offer lookup — is this intent open, and when does it die? */
  private getIntent(intentId: string): Response {
    const now = this.now();
    const stored = this.state.intents.find((candidate) => candidate.intent.id === intentId);
    if (!stored || stored.expiresAt <= now) {
      return jsonResponse({ found: false } satisfies IntentLookupResponse);
    }
    const body: IntentLookupResponse = { found: true, intent: stored.intent, expiresAt: stored.expiresAt };
    return jsonResponse(body);
  }

  /** ProductDO → MarketDO: index a freshly offered product under its intent. */
  private async indexIntentProduct(data: IntentProductRequest): Promise<Response> {
    const ids = this.state.intentProducts[data.intentId] ?? [];
    if (!ids.includes(data.productId)) ids.push(data.productId);
    this.state.intentProducts[data.intentId] = ids;
    await this.ctx.storage.put(STATE_KEY, this.state);
    return jsonResponse({ indexed: true });
  }

  /** Buyer discovery: the products offered against an open intent. */
  private listIntentProducts(intentId: string): Response {
    const now = this.now();
    const stored = this.state.intents.find((candidate) => candidate.intent.id === intentId);
    if (!stored || stored.expiresAt <= now) {
      return jsonResponse({ productIds: [] } satisfies IntentProductsResponse);
    }
    const productIds = this.state.intentProducts[intentId] ?? [];
    return jsonResponse({ productIds } satisfies IntentProductsResponse);
  }

  /**
   * The checkout close gate (domain marketCloseGateOk): a clear refusal when
   * the market is too close to closing for the estimated trip plus buffer.
   */
  private async closeGate(): Promise<Response> {
    const now = this.now();
    const config = await this.config();
    const ok = marketCloseGateOk(now, config.closeAt, config.estTripMs, config.bufferMs);
    const gate: CloseGateResponse = {
      ok,
      refusal: ok
        ? null
        : `Market ${this.state.marketId ?? "unknown"} closes at ${new Date(config.closeAt).toISOString()}; ` +
          `an estimated trip of ${config.estTripMs} ms plus a ${config.bufferMs} ms buffer cannot finish before close. ` +
          `Checkout is refused until the market reopens.`,
      closeAt: config.closeAt,
      now,
      estTripMs: config.estTripMs,
      bufferMs: config.bufferMs,
    };
    return jsonResponse(gate);
  }

  /** Config precedence: DO state (ops writes), then MARKET_CONFIG KV, then defaults. */
  private async config(): Promise<MarketConfig> {
    if (!this.state.config) {
      const marketId = this.state.marketId;
      if (marketId) {
        try {
          const fromKv = await this.env.MARKET_CONFIG.get(`market-config:${marketId}`, "json");
          const parsed = MarketConfigSchema.safeParse(fromKv);
          if (parsed.success) {
            // KV configs are operator-seeded: treat them as ops-set unless
            // explicitly marked otherwise, so they never roll forward.
            this.state.config = { ...parsed.data, opsConfigured: parsed.data.opsConfigured ?? true };
            await this.ctx.storage.put(STATE_KEY, this.state);
          }
        } catch {
          // KV unavailable (e.g. local test runtime) — fall through to defaults.
        }
      }
      if (!this.state.config) {
        this.state.config = defaultMarketConfig(this.now());
        await this.ctx.storage.put(STATE_KEY, this.state);
      }
    }

    // Dev-stage lazy rollover (ADR-0013): an auto-generated config whose
    // closeAt has passed would refuse every checkout forever. For the
    // dev/stage phase, roll it forward by the default open window when the
    // config is next evaluated, persist, and continue as open. Ops-set
    // configs (opsConfigured) never roll — an ops-closed market stays closed.
    if (this.state.config.opsConfigured !== true && this.state.config.closeAt <= this.now()) {
      this.state.config = { ...this.state.config, closeAt: this.now() + MARKET_OPEN_WINDOW_MS };
      await this.ctx.storage.put(STATE_KEY, this.state);
    }
    return this.state.config;
  }

  private async scheduleAlarm(): Promise<void> {
    const now = this.now();
    const nextExpiry = this.state.intents
      .filter((stored) => stored.expiresAt > now)
      .reduce<number | undefined>(
        (next, stored) => (next === undefined ? stored.expiresAt : Math.min(next, stored.expiresAt)),
        undefined,
      );
    // The close gate is evaluated on demand at checkout; only intent TTLs need clocks.
    if (nextExpiry === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(nextExpiry);
  }

  async alarm(): Promise<void> {
    // Doctrine: load state from storage at the start of the alarm.
    this.state = (await this.ctx.storage.get<MarketState>(STATE_KEY)) ?? { intents: [], intentProducts: {}, stores: [], members: [] };
    this.state.intentProducts ??= {};
    this.state.stores ??= [];
    const now = this.now();
    const expired = this.state.intents.filter((stored) => stored.expiresAt <= now);
    for (const stored of expired) {
      broadcast(this.ctx, this.env, {
        type: "intent.expired",
        intentId: stored.intent.id,
        expiredAt: now,
        ...(stored.intent.buyerId ? { buyerId: stored.intent.buyerId } : {}),
      });
    }
    this.state.intents = this.state.intents.filter((stored) => stored.expiresAt > now);
    // The discovery index dies with its intent: drop intentProducts entries
    // for every intent that is gone (expired here, or orphaned by state written
    // before pruning existed). Without this the single-blob state grows until
    // the DO value limit throws.
    const liveIntentIds = new Set(this.state.intents.map((stored) => stored.intent.id));
    for (const intentId of Object.keys(this.state.intentProducts)) {
      if (!liveIntentIds.has(intentId)) delete this.state.intentProducts[intentId];
    }
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.scheduleAlarm();
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await handleWebSocketMessage(ws, message, async (heartbeat) => {
      const store = await coreRegistry(this.env).store(heartbeat.storeId);
      if (store?.sellerParticipantId === heartbeat.participantId && store.market === heartbeat.marketId) {
        await coreRegistry(this.env).heartbeat(heartbeat);
      }
    });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    handleWebSocketClose(ws, code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    handleWebSocketError(ws);
  }
}
