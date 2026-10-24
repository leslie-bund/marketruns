import type { ServerEvent } from "@market-runs/proto";
import { PRESENCE_TTL_MS, notificationSourceEnvelope } from "@market-runs/proto";
import { serializeEvent } from "./wire.js";

interface NotificationSinkEnv {
  NOTIFICATION_QUEUE?: Queue;
}

/** Hibernated-WebSocket helpers: topic-filtered broadcast + inbound control messages. */

export function safeSend(socket: WebSocket, payload: string): void {
  try { socket.send(payload); } catch { /* best-effort broadcast */ }
}

export function eventTopics(event: ServerEvent): string[] {
  switch (event.type) {
    case "intent.recorded": return ["intents", `intent:${event.intent.id}`];
    case "intent.expired": return ["intents", `intent:${event.intentId}`];
    case "product.offered": return [`product:${event.product.id}`, `intent:${event.product.intentId}`];
    case "product.withdrawn": return [`product:${event.productId}`];
    case "negotiation.price-adjusted": return [`product:${event.productId}`];
    case "product.retired": return [`product:${event.productId}`, `intent:${event.intentId}`];
    case "cart.updated": return [`cart:${event.cart.id}`];
    case "checkout.accepted": return [`cart:${event.cartId}`, `run:${event.runId}`];
    case "cart.retired": return [`cart:${event.cartId}`];
    case "run.updated": return [`run:${event.run.id}`];
    case "run.started": case "handoff.initiated": case "handoff.confirmed": case "settlement.released":
      return [`run:${event.runId}`];
    case "run.retired": return [`run:${event.runId}`, `cart:${event.cartId}`];
    case "store.recorded": case "market.member-recorded": return ["market"];
    default: return [];
  }
}

export interface WsAttachment {
  topics: string[];
  participantId: string;
  role: string;
  source: string;
  marketId?: string;
  storeId?: string;
  lastForegroundAt?: number;
  authenticated?: boolean;
  connectedAt?: number;
}

function attachment(socket: WebSocket): WsAttachment | null {
  try { return socket.deserializeAttachment() as WsAttachment | null; } catch { return null; }
}

function socketTopics(socket: WebSocket): string[] {
  const topics = attachment(socket)?.topics;
  return Array.isArray(topics) ? topics : [];
}

/**
 * Broadcast a ServerEvent JSON to the hibernated sockets on this object that
 * subscribed to one of the event's topics. Topic-less sockets (legacy clients)
 * and topic-less events (unclassified types) both receive everything.
 */
export function broadcast(ctx: DurableObjectState, event: ServerEvent): void;
export function broadcast(ctx: DurableObjectState, env: NotificationSinkEnv | undefined, event: ServerEvent): void;
export function broadcast(ctx: DurableObjectState, envOrEvent: NotificationSinkEnv | ServerEvent | undefined, maybeEvent?: ServerEvent): void {
  const event = maybeEvent ?? envOrEvent as ServerEvent;
  const env = maybeEvent === undefined ? undefined : envOrEvent as NotificationSinkEnv | undefined;
  const payload = serializeEvent(event);
  const topics = eventTopics(event);
  for (const socket of ctx.getWebSockets()) {
    const subscribed = socketTopics(socket);
    if (subscribed.length === 0 || topics.length === 0 || topics.some((topic) => subscribed.includes(topic))) safeSend(socket, payload);
  }
  // Queue acceptance is the durable handoff. Websockets above remain best effort;
  // the notifications worker writes Postgres before attempting any delivery.
  if (env?.NOTIFICATION_QUEUE) {
    const envelope = notificationSourceEnvelope("edge", event);
    ctx.waitUntil(env.NOTIFICATION_QUEUE.send(envelope).catch((error: unknown) => {
      console.error(JSON.stringify({ event: "notification.source_send_failed", sourceEventId: envelope.sourceEventId, error: String(error) }));
    }));
  }
}

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/** Identity, store and market are edge-resolved before the hibernatable socket is accepted. */
export function acceptHibernatedWebSocket(
  ctx: DurableObjectState,
  request?: Request,
  scope?: { marketId?: string | undefined },
): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  ctx.acceptWebSocket(server);
  const marketId = scope?.marketId ?? request?.headers.get("x-market-id") ?? undefined;
  const attachment: WsAttachment = {
    topics: [],
    participantId: request?.headers.get("x-resolved-participant-id") ?? request?.headers.get("x-participant-id") ?? "internal",
    role: request?.headers.get("x-resolved-participant-role") ?? request?.headers.get("x-participant-role") ?? request?.headers.get("x-ops-role") ?? "internal",
    source: request?.headers.get("x-resolved-participant-source") ?? "internal",
    authenticated: request?.headers.get("x-ops-observer") === "1" || Boolean(request?.headers.get("x-resolved-participant-id")),
    connectedAt: Date.now(),
    ...(marketId ? { marketId } : {}),
    ...(request?.headers.get("x-store-id") ? { storeId: request.headers.get("x-store-id")! } : {}),
  };
  server.serializeAttachment(attachment);
  return new Response(null, { status: 101, webSocket: client });
}

interface WsControlMessage {
  type?: unknown;
  topics?: unknown;
  foreground?: unknown;
}

export interface PresenceHeartbeat {
  marketId: string;
  participantId: string;
  storeId: string;
  lastSeenAt: number;
}

/** Subscribe preserves identity attachments; only explicit foreground heartbeats refresh presence. */
export async function handleWebSocketMessage(
  socket: WebSocket,
  message: string | ArrayBuffer,
  onHeartbeat?: (heartbeat: PresenceHeartbeat) => Promise<void>,
): Promise<void> {
  if (typeof message !== "string") return;
  let data: WsControlMessage;
  try { data = JSON.parse(message) as WsControlMessage; } catch { return; }
  if (typeof data !== "object" || data === null) return;
  if (data.type === "ping") { safeSend(socket, JSON.stringify({ type: "pong" })); return; }
  const current = attachment(socket);
  if (!current) return;
  if (data.type === "subscribe") {
    if (Array.isArray(data.topics)) {
      socket.serializeAttachment({
        ...current,
        topics: data.topics.filter((topic): topic is string => typeof topic === "string").slice(0, 100),
      });
    }
    safeSend(socket, JSON.stringify({ type: "subscribed" }));
    return;
  }
  if (data.type === "heartbeat" && data.foreground === true) {
    const now = Date.now();
    socket.serializeAttachment({ ...current, lastForegroundAt: now });
    if (onHeartbeat && current.role === "seller" && current.marketId && current.storeId &&
        (current.source === "session" || current.source === "header")) {
      await onHeartbeat({ marketId: current.marketId, participantId: current.participantId, storeId: current.storeId, lastSeenAt: now });
      safeSend(socket, JSON.stringify({ type: "presence", onlineUntil: now + PRESENCE_TTL_MS }));
    } else {
      safeSend(socket, JSON.stringify({ type: "pong" }));
    }
  }
}

export function handleWebSocketClose(socket: WebSocket, code: number, reason: string): void {
  try { socket.close(code, reason); } catch { /* already closed */ }
}

export function handleWebSocketError(socket: WebSocket): void {
  try { socket.close(1011, "server error"); } catch { /* already closed */ }
}
