import { createDatabase } from "./db.js";
import type { Env } from "./env.js";
import { RequestIdSchema } from "@market-runs/proto";
import {
  listAdminDisputes,
  listAdminLedger,
  listAdminRuns,
  listAdminSettlements,
  loadOpsHealth,
  optionalFilter,
  parseListParams,
  parseOpsHealthQuery,
  parseRunKindFilter,
} from "./admin.js";
import { parseArchiveMessage, type ArchiveMessage } from "./messages.js";
import { persistMessage } from "./persist.js";
import { loadReputation, parseReputationQuery } from "./reputation.js";

/**
 * Request correlation (x-request-id): honor a well-formed inbound id, else
 * generate one; echo it on the response and emit one parseable log line per
 * request — { requestId, method, path, status, ms }. Cheap, no bodies.
 */
function resolveRequestId(header: string | null): string {
  return header !== null && RequestIdSchema.safeParse(header).success ? header : crypto.randomUUID();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const started = Date.now();
    const requestId = resolveRequestId(request.headers.get("x-request-id"));
    let status = 500;
    try {
      const response = await routeRequest(request, env);
      status = response.status;
      try {
        response.headers.set("x-request-id", requestId);
      } catch {
        /* immutable headers — skip the echo, keep the log line */
      }
      return response;
    } finally {
      console.log(
        JSON.stringify({
          requestId,
          method: request.method,
          path: new URL(request.url).pathname,
          status,
          ms: Date.now() - started,
        }),
      );
    }
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const parsed: Array<{ message: Message; value: ArchiveMessage }> = [];
    for (const message of batch.messages) {
      const result = parseArchiveMessage(message.body);
      if (!result.success) {
        console.error(
          JSON.stringify({ event: "archive.dead_letter", messageId: message.id, issues: result.error.issues }),
        );
        message.ack();
        continue;
      }
      parsed.push({ message, value: result.data });
    }
    if (parsed.length === 0) return;

    const { db, client } = createDatabase(env);
    try {
      await db.transaction(async (tx) => {
        // run.retired must precede settlement.released for the FK; queue
        // batches are not ordered guarantees, so impose the durable order.
        const ordered = [...parsed].sort((a, b) => rank(a.value.type) - rank(b.value.type));
        for (const { message, value } of ordered) {
          try {
            await persistMessage(tx, value, env.ARCHIVE_BUCKET);
            // One line per persisted message; requestId joins the row to the
            // originating request's trace when the emitter carried one.
            console.log(
              JSON.stringify({
                event: "archive.persisted",
                type: value.type,
                messageId: message.id,
                ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
              }),
            );
            message.ack();
          } catch (error) {
            console.error(
              JSON.stringify({
                event: "archive.dead_letter",
                messageId: message.id,
                ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
                error: String(error),
              }),
            );
            throw error;
          }
        }
      });
    } finally {
      await client.end();
    }
  },
};

async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") {
    return Response.json({ ok: true, service: "market-runs-archive" });
  }
  if (request.method === "GET" && url.pathname === "/reputation") {
    const parsed = parseReputationQuery(url);
    if (parsed instanceof Response) return parsed;
    const { db, client } = createDatabase(env);
    try {
      const reputation = await db.transaction(async (tx) => loadReputation(tx, parsed.participantId, parsed.role));
      return Response.json(reputation);
    } finally {
      await client.end();
    }
  }
  if (request.method === "GET" && url.pathname === "/admin/runs") {
    const params = parseListParams(url);
    if (params instanceof Response) return params;
    const kind = parseRunKindFilter(url);
    if (kind instanceof Response) return kind;
    const { db, client } = createDatabase(env);
    try {
      const list = await db.transaction(async (tx) =>
        listAdminRuns(
          tx,
          { market: optionalFilter(url, "market"), status: optionalFilter(url, "status"), runnerId: optionalFilter(url, "runnerId"), storeId: optionalFilter(url, "storeId"), kind },
          params,
        ),
      );
      return Response.json(list);
    } finally {
      await client.end();
    }
  }
  if (request.method === "GET" && url.pathname === "/admin/disputes") {
    const params = parseListParams(url);
    if (params instanceof Response) return params;
    const { db, client } = createDatabase(env);
    try {
      const list = await db.transaction(async (tx) =>
        listAdminDisputes(tx, { status: optionalFilter(url, "status") }, params),
      );
      return Response.json(list);
    } finally {
      await client.end();
    }
  }
  if (request.method === "GET" && url.pathname === "/admin/settlements") {
    const params = parseListParams(url);
    if (params instanceof Response) return params;
    const { db, client } = createDatabase(env);
    try {
      const list = await db.transaction(async (tx) =>
        listAdminSettlements(tx, { market: optionalFilter(url, "market") }, params),
      );
      return Response.json(list);
    } finally {
      await client.end();
    }
  }
  if (request.method === "GET" && url.pathname === "/admin/ledger") {
    const params = parseListParams(url);
    if (params instanceof Response) return params;
    const { db, client } = createDatabase(env);
    try {
      const list = await db.transaction(async (tx) =>
        listAdminLedger(tx, { market: optionalFilter(url, "market") }, params),
      );
      return Response.json(list);
    } finally {
      await client.end();
    }
  }
  if (request.method === "GET" && url.pathname === "/admin/ops-health") {
    const parsed = parseOpsHealthQuery(url);
    if (parsed instanceof Response) return parsed;
    const { db, client } = createDatabase(env);
    try {
      const health = await db.transaction(async (tx) => loadOpsHealth(tx, parsed.market));
      return Response.json(health);
    } finally {
      await client.end();
    }
  }
  return Response.json({ error: "not-found", message: `no route: ${request.method} ${url.pathname}` }, { status: 404 });
}

function rank(type: string): number {
  // run.started first so a same-batch run.retired always finds its live_runs
  // row; run.retired precedes settlement.released for the FK.
  return type === "run.started" ? 0 : type === "run.retired" ? 1 : type === "settlement.released" ? 2 : 3;
}
