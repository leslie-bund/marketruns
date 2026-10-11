import { DurableObject } from "cloudflare:workers";
import { INTENT_TTL_MS, marketCloseGateOk } from "@market-runs/domain";
import type { Intent, IntentPosted, ServerEvent } from "@market-runs/proto";
import type { Env } from "../env.js";
import {
  STATE_KEY,
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
} from "../protocol.js";
import {
  MarketConfigSchema,
  defaultMarketConfig,
  type CloseGateResponse,
  type IntentLookupResponse,
  type MarketConfig,
} from "../internal.js";

interface StoredIntent {
  intent: Intent;
  /** createdAt + INTENT_TTL_MS; the intent dies here. */
  expiresAt: number;
}

interface MarketState {
  marketId?: string;
  intents: StoredIntent[];
  config?: MarketConfig;
  /** Deterministic-time seam: epoch offset added to Date.now(). 0 in production. */
  timeOffsetMs?: number;
}

/**
 * Per market zone: intents, the open/close gate, and market config (floor-rate
 * and settlement coefficients). Live state only — durable records leave at
 * retirement via the archive queue (ADR-0010).
 */
export class MarketDO extends DurableObject<Env> {
  private state: MarketState = { intents: [] };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private now(): number {
    return Date.now() + (this.state.timeOffsetMs ?? 0);
  }

  async fetch(request: Request): Promise<Response> {
    // Doctrine: load state from storage at the start of every fetch.
    this.state = (await this.ctx.storage.get<MarketState>(STATE_KEY)) ?? { intents: [] };
    const url = new URL(request.url);
    const path = url.pathname.endsWith("/") && url.pathname.length > 1 ? url.pathname.slice(0, -1) : url.pathname;

    if (isWebSocketUpgrade(request)) return acceptHibernatedWebSocket(this.ctx);

    if (request.method === "POST" && path === "/intent") {
      const parsed = await parseClientCommand(request);
      const command = expectCommand(parsed, "intent.posted");
      if (command instanceof Response) return command;
      return internalErrorGuard(() => this.postIntent(command));
    }
    if (request.method === "GET" && path === "/intents") {
      return this.listOpenIntents();
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
      this.state.config = parsed.data;
      const headerMarket = request.headers.get("x-market-id");
      if (this.state.marketId === undefined && headerMarket !== null) this.state.marketId = headerMarket;
      await this.ctx.storage.put(STATE_KEY, this.state);
      return jsonResponse(parsed.data);
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
    };
    this.state.intents.push({ intent, expiresAt: now + INTENT_TTL_MS });
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.scheduleAlarm();

    const event: ServerEvent = { type: "intent.recorded", intent };
    broadcast(this.ctx, event);
    return jsonResponse(event);
  }

  /** Open, unexpired intents visible to matching stores. */
  private listOpenIntents(): Response {
    const now = this.now();
    const intents = this.state.intents
      .filter((stored) => stored.expiresAt > now)
      .map((stored) => stored.intent);
    return jsonResponse({ intents });
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
    if (this.state.config) return this.state.config;
    const marketId = this.state.marketId;
    if (marketId) {
      try {
        const fromKv = await this.env.MARKET_CONFIG.get(`market-config:${marketId}`, "json");
        const parsed = MarketConfigSchema.safeParse(fromKv);
        if (parsed.success) {
          this.state.config = parsed.data;
          await this.ctx.storage.put(STATE_KEY, this.state);
          return parsed.data;
        }
      } catch {
        // KV unavailable (e.g. local test runtime) — fall through to defaults.
      }
    }
    this.state.config = defaultMarketConfig(this.now());
    await this.ctx.storage.put(STATE_KEY, this.state);
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
    this.state = (await this.ctx.storage.get<MarketState>(STATE_KEY)) ?? { intents: [] };
    const now = this.now();
    const expired = this.state.intents.filter((stored) => stored.expiresAt <= now);
    for (const stored of expired) {
      broadcast(this.ctx, { type: "intent.expired", intentId: stored.intent.id, expiredAt: now });
    }
    this.state.intents = this.state.intents.filter((stored) => stored.expiresAt > now);
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.scheduleAlarm();
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
