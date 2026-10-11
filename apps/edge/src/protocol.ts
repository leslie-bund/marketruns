import { z } from "zod";
import {
  ClientCommandSchema,
  ServerEventSchema,
  type ClientCommand,
  type ServerEvent,
} from "@market-runs/proto";

/**
 * The command boundary: every client-sent body parses as a ClientCommand and
 * every body the edge emits parses as a ServerEvent. No parallel ad-hoc wire
 * types (AGENTS.md doctrine). Internal DO-to-DO payloads are validated in
 * internal.ts and are not the client wire.
 */

export const STATE_KEY = "state";

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function errorResponse(
  status: number,
  error: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return jsonResponse({ error, message, ...extra }, status);
}

export function notFound(message: string): Response {
  return errorResponse(404, "not-found", message);
}

export function conflict(message: string, extra?: Record<string, unknown>): Response {
  return errorResponse(409, "conflict", message, extra);
}

/** A domain refusal (close gate, lapsed deadline): 409 with a clear reason. */
export function refusal(code: string, message: string): Response {
  return errorResponse(409, code, message, { refusal: message });
}

/** Wrap a DO handler so unexpected failures become 500s, never hangs. */
export async function internalErrorGuard(handler: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    return errorResponse(500, "internal-error", error instanceof Error ? error.message : String(error));
  }
}

function invalidBody(message: string, issues?: unknown): Response {
  return errorResponse(400, "invalid-body", message, issues === undefined ? {} : { issues });
}

export type ParsedCommand =
  | { ok: true; command: ClientCommand }
  | { ok: false; response: Response };

export async function parseClientCommand(request: Request): Promise<ParsedCommand> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: invalidBody("request body is not valid JSON") };
  }
  const parsed = ClientCommandSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: invalidBody("request body failed ClientCommandSchema validation", parsed.error.issues) };
  }
  return { ok: true, command: parsed.data };
}

/** Narrow a parsed command to one discriminant, or 400. */
export function expectCommand<T extends ClientCommand["type"]>(
  parsed: ParsedCommand,
  type: T,
): Extract<ClientCommand, { type: T }> | Response {
  if (!parsed.ok) return parsed.response;
  if (parsed.command.type !== type) {
    return invalidBody(`expected command ${type}, got ${parsed.command.type}`);
  }
  return parsed.command as Extract<ClientCommand, { type: T }>;
}

export type ParsedInternal<S extends z.ZodTypeAny> =
  | { ok: true; data: z.infer<S> }
  | { ok: false; response: Response };

/** Validate an internal DO-to-DO request body against its zod schema. */
export async function parseInternal<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<ParsedInternal<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: invalidBody("request body is not valid JSON") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: invalidBody("request body failed schema validation", parsed.error.issues) };
  }
  return { ok: true, data: parsed.data };
}

/** Serialize a ServerEvent for the wire, failing fast if we ever drift. */export function serializeEvent(event: ServerEvent): string {
  return JSON.stringify(ServerEventSchema.parse(event));
}

export function safeSend(socket: WebSocket, payload: string): void {
  try {
    socket.send(payload);
  } catch {
    // Socket closed mid-flight; broadcasts are best-effort.
  }
}

/** Broadcast a ServerEvent JSON to every hibernated socket on this object. */
export function broadcast(ctx: DurableObjectState, event: ServerEvent): void {
  const payload = serializeEvent(event);
  for (const socket of ctx.getWebSockets()) safeSend(socket, payload);
}

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/**
 * Accept a hibernatable WebSocket upgrade (AGENTS.md: WebSocket hibernation).
 * Returns the 101 response with the client end of the pair.
 */
export function acceptHibernatedWebSocket(ctx: DurableObjectState): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  ctx.acceptWebSocket(server);
  server.serializeAttachment({ topics: [] as string[] });
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
      socket.serializeAttachment({
        topics: data.topics.filter((topic): topic is string => typeof topic === "string"),
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
