import { NotificationMarkReadRequestSchema } from "@market-runs/proto";
import { consumeNotificationMessage } from "./consumer.js";
import { createDatabase } from "./db.js";
import { DrizzleNotificationStore } from "./drizzle-store.js";
import type { Env } from "./env.js";
import { createProviders, type NotificationProviders } from "./provider.js";
import type { NotificationStore } from "./store.js";

export interface NotificationsAppOptions {
  internalToken?: string | undefined;
}

function authorized(request: Request, token?: string): boolean {
  return !token || request.headers.get("x-notification-internal") === token;
}

function jsonError(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
}

async function route(store: NotificationStore, request: Request, options: NotificationsAppOptions): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") return Response.json({ ok: true, service: "market-runs-notifications" });
  if (!authorized(request, options.internalToken)) return jsonError(401, "unauthorized", "valid internal authentication is required");
  const recipientId = request.headers.get("x-participant-id");
  if (!recipientId) return jsonError(400, "recipient-required", "trusted participant attribution is required");

  if (request.method === "GET" && url.pathname === "/notifications") {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
      return jsonError(400, "invalid-query", "limit must be 1–100 and offset must be non-negative");
    }
    return Response.json(await store.list(recipientId, { limit, offset, unreadOnly: url.searchParams.get("unread") === "true" }));
  }
  if (request.method === "POST" && url.pathname === "/notifications/read") {
    let body: unknown;
    try { body = await request.json(); } catch { return jsonError(400, "invalid-body", "request body is not valid JSON"); }
    const parsed = NotificationMarkReadRequestSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, "invalid-body", "ids must contain 1–100 notification ids");
    return Response.json({ updated: await store.markRead(recipientId, parsed.data.ids, new Date()) });
  }
  return jsonError(404, "not-found", `no route: ${request.method} ${url.pathname}`);
}

export function createNotificationsApp(store: NotificationStore, providers: NotificationProviders, options: NotificationsAppOptions = {}) {
  return {
    fetch: (request: Request) => route(store, request, options),
    async queue(batch: MessageBatch<unknown>): Promise<void> {
      for (const message of batch.messages) await consumeNotificationMessage(store, providers, message);
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { db, client } = createDatabase(env);
    try {
      return await route(new DrizzleNotificationStore(db), request, { internalToken: env.NOTIFICATION_INTERNAL_TOKEN });
    } finally {
      await client.end();
    }
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const { db, client } = createDatabase(env);
    try {
      const app = createNotificationsApp(new DrizzleNotificationStore(db), createProviders({
        resendApiKey: env.RESEND_API_KEY,
        resendFromEmail: env.RESEND_FROM_EMAIL,
        edgeUrl: env.EDGE_URL,
        edgeInternalToken: env.NOTIFICATION_INTERNAL_TOKEN,
      }), { internalToken: env.NOTIFICATION_INTERNAL_TOKEN });
      await app.queue(batch);
    } finally {
      await client.end();
    }
  },
};
