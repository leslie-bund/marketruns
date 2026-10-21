import {
  ClientCommandSchema,
  ServerEventSchema,
  type ClientCommand,
  type ServerEvent,
} from "@market-runs/proto";
import { errorResponse } from "./responses.js";

/** The client command boundary: every client-sent body parses as a ClientCommand. */

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

/** Serialize a ServerEvent for the wire, failing fast if we ever drift. */
export function serializeEvent(event: ServerEvent): string {
  return JSON.stringify(ServerEventSchema.parse(event));
}
