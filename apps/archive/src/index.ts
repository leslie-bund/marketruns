import { createDatabase } from "./db.js";
import type { Env } from "./env.js";
import { buildPaymentDispatchRequest, buildPaymentRefundRequest } from "@market-runs/domain";
import { RequestIdSchema, notificationSourceEnvelope, type SettlementReleased } from "@market-runs/proto";
import { eq } from "drizzle-orm";
import { runsArchive, settlementRecords } from "../../../infra/drizzle/schema.js";
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
    // run.retired must precede settlement.released for the FK; queue batches
    // are not ordered guarantees, so impose the same durable order on both
    // persistence and post-commit delivery.
    const ordered = [...parsed].sort((a, b) => rank(a.value.type) - rank(b.value.type));
    try {
      await db.transaction(async (tx) => {
        for (const { message, value } of ordered) {
          try {
            await persistMessage(tx, value, env.ARCHIVE_BUCKET);
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

      // Nothing external is sent until every durable write has committed. A
      // post-commit failure retries only its own message; replay is idempotent.
      for (const { message, value } of ordered) {
        try {
          if (value.type === "settlement.released") {
            await emitSettlementPayments(db, value, env.PAYMENT_QUEUE);
          }
          if (env.NOTIFICATION_QUEUE) {
            // The original edge event id is retained so archive + realtime sinks dedupe.
            await env.NOTIFICATION_QUEUE.send(notificationSourceEnvelope("edge", value));
          }
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
              event: "archive.post_commit_failed",
              type: value.type,
              messageId: message.id,
              ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
              error: String(error),
            }),
          );
          message.retry({ delaySeconds: 30 });
        }
      }
    } finally {
      await client.end();
    }
  },
};

type ArchiveDatabase = ReturnType<typeof createDatabase>["db"];

/** Build payment execution requests exclusively from the committed durable record. */
async function emitSettlementPayments(
  db: ArchiveDatabase,
  message: SettlementReleased,
  paymentQueue: Queue,
): Promise<void> {
  const [record] = await db
    .select({
      outcome: settlementRecords.outcome,
      runId: runsArchive.id,
      market: runsArchive.marketId,
      buyerId: runsArchive.buyerId,
      runnerId: runsArchive.runnerId,
    })
    .from(settlementRecords)
    .innerJoin(runsArchive, eq(settlementRecords.runId, runsArchive.id))
    .where(eq(settlementRecords.runId, message.runId))
    .limit(1);
  if (!record) throw new Error(`committed settlement not found for run ${message.runId}`);

  const requestId = message.requestId;
  const dispatch = buildPaymentDispatchRequest(record.outcome, {
    runId: record.runId,
    market: record.market,
    runnerId: record.runnerId,
    ...(requestId !== undefined ? { requestId } : {}),
  });
  const refund = buildPaymentRefundRequest(record.outcome, {
    runId: record.runId,
    buyerId: record.buyerId,
    ...(requestId !== undefined ? { requestId } : {}),
  });
  const requests = [
    ...(dispatch.legs.length > 0 ? [dispatch] : []),
    ...(refund !== null ? [refund] : []),
  ];
  if (requests.length > 0) {
    await paymentQueue.sendBatch(requests.map((body) => ({ body })));
  }
}

async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (env.ARCHIVE_ENV && env.ARCHIVE_ENV !== "development" && env.ARCHIVE_ENV !== "test") {
    if (env.ARCHIVE_ENV !== "staging" && env.ARCHIVE_ENV !== "production") {
      return Response.json(
        { error: "archive-topology-unconfigured", message: "ARCHIVE_ENV must be development, test, staging, or production" },
        { status: 503 },
      );
    }
    if (!env.ARCHIVE_INTERNAL_TOKEN) {
      return Response.json(
        { error: "archive-topology-unconfigured", message: `ARCHIVE_INTERNAL_TOKEN is required when ARCHIVE_ENV=${env.ARCHIVE_ENV}` },
        { status: 503 },
      );
    }
  }
  if (request.method === "GET" && url.pathname === "/healthz") {
    return Response.json({ ok: true, service: "market-runs-archive" });
  }
  if (url.pathname === "/reputation" || url.pathname.startsWith("/admin/")) {
    if (env.ARCHIVE_INTERNAL_TOKEN) {
      if (request.headers.get("x-archive-internal") !== env.ARCHIVE_INTERNAL_TOKEN) {
        return Response.json({ error: "unauthorized", message: "valid internal authentication is required" }, { status: 401 });
      }
    } else if (env.ALLOW_HEADER_AUTH !== "true") {
      return Response.json(
        { error: "archive-auth-unconfigured", message: "ARCHIVE_INTERNAL_TOKEN is required" },
        { status: 503 },
      );
    }
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
