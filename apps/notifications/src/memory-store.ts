import type { Notification, NotificationChannel, NotificationListResponse } from "@market-runs/proto";
import type { NotificationDraft } from "./drafts.js";
import type { NotificationStore, OutboxResult, OutboxRow } from "./store.js";

function view(row: Notification): Notification {
  return { ...row, data: { ...row.data } };
}

/** Deterministic in-memory store for unit/sandbox tests; production uses Drizzle/Postgres. */
export class MemoryNotificationStore implements NotificationStore {
  readonly notifications = new Map<string, Notification>();
  readonly outbox = new Map<string, OutboxRow & { lastError?: string; providerRef?: string; availableAt?: Date }>();

  async ingest(drafts: NotificationDraft[]): Promise<Notification[]> {
    const result: Notification[] = [];
    for (const draft of drafts) {
      let row = [...this.notifications.values()].find((candidate) => candidate.recipientId === draft.recipientId && candidate.dedupeKey === draft.dedupeKey);
      if (!row) {
        row = {
          id: `notification:${crypto.randomUUID()}`,
          recipientId: draft.recipientId,
          sourceEventId: draft.sourceEventId,
          sourceEventType: draft.sourceEventType,
          dedupeKey: draft.dedupeKey,
          category: draft.category,
          title: draft.title,
          body: draft.body,
          ...(draft.deepLink ? { deepLink: draft.deepLink } : {}),
          data: draft.data,
          createdAt: draft.occurredAt,
          readAt: null,
        };
        this.notifications.set(row.id, row);
      }
      const channels: NotificationChannel[] = ["websocket", ...(draft.email ? ["email" as const] : [])];
      for (const channel of channels) {
        const id = `outbox:${row.id}:${channel}`;
        if (!this.outbox.has(id)) {
          this.outbox.set(id, { id, notificationId: row.id, channel, status: "pending", attempts: 0 });
        }
      }
      result.push(view(row));
    }
    return result;
  }

  async list(recipientId: string, options: { limit: number; offset: number; unreadOnly: boolean }): Promise<NotificationListResponse> {
    const owned = [...this.notifications.values()].filter((row) => row.recipientId === recipientId);
    const filtered = owned.filter((row) => !options.unreadOnly || row.readAt === null).sort((a, b) => b.createdAt - a.createdAt);
    return {
      items: filtered.slice(options.offset, options.offset + options.limit).map(view),
      total: filtered.length,
      unread: owned.filter((row) => row.readAt === null).length,
      limit: options.limit,
      offset: options.offset,
    };
  }

  async markRead(recipientId: string, ids: string[], readAt: Date): Promise<number> {
    let updated = 0;
    for (const id of new Set(ids)) {
      const row = this.notifications.get(id);
      if (row && row.recipientId === recipientId && row.readAt === null) {
        row.readAt = readAt.getTime();
        updated += 1;
      }
    }
    return updated;
  }

  async pendingOutbox(notificationId: string): Promise<OutboxRow[]> {
    return [...this.outbox.values()].filter((row) => row.notificationId === notificationId && row.status === "pending");
  }

  async recordOutbox(id: string, result: OutboxResult): Promise<void> {
    const row = this.outbox.get(id);
    if (!row) return;
    row.status = result.status;
    row.attempts += 1;
    if (result.error !== undefined) row.lastError = result.error;
    else delete row.lastError;
    if (result.providerRef !== undefined) row.providerRef = result.providerRef;
    else delete row.providerRef;
    if (result.availableAt !== undefined) row.availableAt = result.availableAt;
    else delete row.availableAt;
  }
}
