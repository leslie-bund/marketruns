import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Notification, NotificationChannel, NotificationListResponse } from "@market-runs/proto";
import { notificationOutbox, notifications } from "../../../infra/drizzle/schema.js";
import type { createDatabase } from "./db.js";
import type { NotificationDraft } from "./drafts.js";
import type { NotificationStore, OutboxResult, OutboxRow } from "./store.js";

type Database = ReturnType<typeof createDatabase>["db"];
type NotificationRow = typeof notifications.$inferSelect;

function view(row: NotificationRow): Notification {
  return {
    id: row.id,
    recipientId: row.recipientId,
    sourceEventId: row.sourceEventId,
    sourceEventType: row.sourceEventType,
    dedupeKey: row.dedupeKey,
    category: row.category as Notification["category"],
    title: row.title,
    body: row.body,
    ...(row.deepLink ? { deepLink: row.deepLink } : {}),
    data: (row.data ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.getTime(),
    readAt: row.readAt?.getTime() ?? null,
  };
}

export class DrizzleNotificationStore implements NotificationStore {
  constructor(private readonly db: Database) {}

  async ingest(drafts: NotificationDraft[]): Promise<Notification[]> {
    return this.db.transaction(async (tx) => {
      const result: Notification[] = [];
      for (const draft of drafts) {
        const id = `notification:${crypto.randomUUID()}`;
        await tx.insert(notifications).values({
          id,
          recipientId: draft.recipientId,
          sourceEventId: draft.sourceEventId,
          sourceEventType: draft.sourceEventType,
          dedupeKey: draft.dedupeKey,
          category: draft.category,
          title: draft.title,
          body: draft.body,
          deepLink: draft.deepLink,
          data: draft.data,
          createdAt: new Date(draft.occurredAt),
        }).onConflictDoNothing({ target: [notifications.recipientId, notifications.dedupeKey] });
        const rows = await tx.select().from(notifications).where(and(eq(notifications.recipientId, draft.recipientId), eq(notifications.dedupeKey, draft.dedupeKey))).limit(1);
        const row = rows[0];
        if (!row) throw new Error("notification insert conflicted but durable row is unreadable");
        const channels: NotificationChannel[] = ["websocket", ...(draft.email ? ["email" as const] : [])];
        for (const channel of channels) {
          await tx.insert(notificationOutbox).values({
            id: `outbox:${row.id}:${channel}`,
            notificationId: row.id,
            channel,
          }).onConflictDoNothing({ target: [notificationOutbox.notificationId, notificationOutbox.channel] });
        }
        result.push(view(row));
      }
      return result;
    });
  }

  async list(recipientId: string, options: { limit: number; offset: number; unreadOnly: boolean }): Promise<NotificationListResponse> {
    const ownership = eq(notifications.recipientId, recipientId);
    const where = options.unreadOnly ? and(ownership, isNull(notifications.readAt)) : ownership;
    const [items, totals, unreads] = await Promise.all([
      this.db.select().from(notifications).where(where).orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(options.limit).offset(options.offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(notifications).where(where),
      this.db.select({ count: sql<number>`count(*)::int` }).from(notifications).where(and(ownership, isNull(notifications.readAt))),
    ]);
    return {
      items: items.map(view),
      total: totals[0]?.count ?? 0,
      unread: unreads[0]?.count ?? 0,
      limit: options.limit,
      offset: options.offset,
    };
  }

  async markRead(recipientId: string, ids: string[], readAt: Date): Promise<number> {
    const rows = await this.db.update(notifications).set({ readAt }).where(and(
      eq(notifications.recipientId, recipientId),
      inArray(notifications.id, [...new Set(ids)]),
      isNull(notifications.readAt),
    )).returning({ id: notifications.id });
    return rows.length;
  }

  async pendingOutbox(notificationId: string): Promise<OutboxRow[]> {
    const rows = await this.db.select().from(notificationOutbox).where(and(eq(notificationOutbox.notificationId, notificationId), eq(notificationOutbox.status, "pending")));
    return rows.map((row) => ({ id: row.id, notificationId: row.notificationId, channel: row.channel as NotificationChannel, status: row.status as OutboxRow["status"], attempts: row.attempts }));
  }

  async recordOutbox(id: string, result: OutboxResult): Promise<void> {
    await this.db.update(notificationOutbox).set({
      status: result.status,
      attempts: sql`${notificationOutbox.attempts} + 1`,
      lastError: result.error ?? null,
      providerRef: result.providerRef ?? null,
      ...(result.availableAt ? { availableAt: result.availableAt } : {}),
      updatedAt: new Date(),
    }).where(eq(notificationOutbox.id, id));
  }
}
