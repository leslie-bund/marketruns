import type { ServerEvent } from "@market-runs/proto";
import { serializeEvent } from "./wire.js";

/** Hibernated-WebSocket helpers: topic-filtered broadcast + inbound control messages. */

export function safeSend(socket: WebSocket, payload: string): void {
  try {
    socket.send(payload);
  } catch {
    // Socket closed mid-flight; broadcasts are best-effort.
  }
}

/**
 * The topic taxonomy. A socket declares the topics it wants via the
 * `subscribe` control message; `broadcast` delivers an event only to sockets
 * whose topics intersect the event's topics.
 *
 *   intents          — intent lifecycle for sellers (intent.recorded / intent.expired)
 *   intent:<id>      — one intent's lifecycle, for the buyer who posted it
 *   product:<id>     — one product's negotiation/retirement
 *   cart:<id>        — one cart's updates/checkout/retirement
 *   run:<id>         — one run's updates, handoffs, settlement, retirement
 *   market           — market-scope config/registry news (store.recorded, member-recorded)
 *
 * Item-level filtering ("only intents for MY shop items") is deliberately NOT
 * a topic: topics classify events, the /discovery read scopes items (ADR-0006).
 *
 * Compatibility rule (clients before topics existed sent no subscribe at all):
 * a socket with NO recorded topics is a legacy full-subscribe and receives
 * everything. An event type missing from the map below also fails open
 * (delivered to every socket) — classify new event types here when adding them.
 * Queue-only payloads (payment.*, kyc.verification-result, participant.recorded)
 * are never broadcast to market sockets, so they need no topics.
 */
export function eventTopics(event: ServerEvent): string[] {
  switch (event.type) {
    case "intent.recorded":
      return ["intents", `intent:${event.intent.id}`];
    case "intent.expired":
      return ["intents", `intent:${event.intentId}`];
    case "product.offered":
      return [`product:${event.product.id}`, `intent:${event.product.intentId}`];
    case "product.withdrawn":
      return [`product:${event.productId}`];
    case "negotiation.price-adjusted":
      return [`product:${event.productId}`];
    case "product.retired":
      return [`product:${event.productId}`, `intent:${event.intentId}`];
    case "cart.updated":
      return [`cart:${event.cart.id}`];
    case "checkout.accepted":
      return [`cart:${event.cartId}`, `run:${event.runId}`];
    case "cart.retired":
      return [`cart:${event.cartId}`];
    case "run.updated":
      return [`run:${event.run.id}`];
    case "run.started":
      return [`run:${event.runId}`];
    case "handoff.initiated":
      return [`run:${event.runId}`];
    case "handoff.confirmed":
      return [`run:${event.runId}`];
    case "settlement.released":
      return [`run:${event.runId}`];
    case "run.retired":
      return [`run:${event.runId}`, `cart:${event.cartId}`];
    case "store.recorded":
      return ["market"];
    case "market.member-recorded":
      return ["market"];
    default:
      // payment.*, kyc.verification-result, participant.recorded and any
      // future unclassified type: fail open so nothing silently goes dark.
      return [];
  }
}

interface WsAttachment {
  topics?: string[];
  authenticated?: boolean;
  role?: string;
  connectedAt?: number;
}

/** The topics a hibernated socket recorded via `subscribe` ([] when none / unreadable). */
function socketTopics(socket: WebSocket): string[] {
  try {
    const attachment = socket.deserializeAttachment() as WsAttachment | null;
    return Array.isArray(attachment?.topics) ? attachment.topics : [];
  } catch {
    return [];
  }
}

/**
 * Broadcast a ServerEvent JSON to the hibernated sockets on this object that
 * subscribed to one of the event's topics. Topic-less sockets (legacy clients)
 * and topic-less events (unclassified types) both receive everything.
 */
export function broadcast(ctx: DurableObjectState, event: ServerEvent): void {
  const payload = serializeEvent(event);
  const topics = eventTopics(event);
  for (const socket of ctx.getWebSockets()) {
    const subscribed = socketTopics(socket);
    if (subscribed.length === 0 || topics.length === 0 || topics.some((topic) => subscribed.includes(topic))) {
      safeSend(socket, payload);
    }
  }
}

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/**
 * Accept a hibernatable WebSocket upgrade (AGENTS.md: WebSocket hibernation).
 * Returns the 101 response with the client end of the pair.
 */
export function acceptHibernatedWebSocket(
  ctx: DurableObjectState,
  identity: { authenticated?: boolean; role?: string | undefined } = {},
): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  ctx.acceptWebSocket(server);
  server.serializeAttachment({
    topics: [] as string[], authenticated: identity.authenticated === true,
    ...(identity.role ? { role: identity.role } : {}), connectedAt: Date.now(),
  });
  return new Response(null, { status: 101, webSocket: client });
}

interface WsControlMessage {
  type?: unknown;
  topics?: unknown;
}

/**
 * Lightweight inbound WS commands. `ping` → `pong`; `subscribe` records topic
 * filters on the hibernation attachment and acks. Unknown messages are
 * ignored — this handler must never throw under hibernation.
 */
export function handleWebSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
  if (typeof message !== "string") return;
  let data: WsControlMessage;
  try {
    data = JSON.parse(message) as WsControlMessage;
  } catch {
    return;
  }
  if (typeof data !== "object" || data === null) return;
  if (data.type === "ping") {
    safeSend(socket, JSON.stringify({ type: "pong" }));
    return;
  }
  if (data.type === "subscribe") {
    if (Array.isArray(data.topics)) {
      let current: WsAttachment = {};
      try { current = (socket.deserializeAttachment() as WsAttachment | null) ?? {}; } catch { /* retain safe defaults */ }
      socket.serializeAttachment({
        ...current,
        topics: data.topics.filter((topic): topic is string => typeof topic === "string").slice(0, 100),
      });
    }
    safeSend(socket, JSON.stringify({ type: "subscribed" }));
  }
}

/** The close handler must not throw under hibernation. */
export function handleWebSocketClose(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed; nothing to do.
  }
}

export function handleWebSocketError(socket: WebSocket): void {
  try {
    socket.close(1011, "server error");
  } catch {
    // Already closed; nothing to do.
  }
}
