import type { Notification, NotificationChannel, NotificationListResponse } from "@market-runs/proto";
import type { NotificationDraft } from "./drafts.js";

export interface OutboxRow {
  id: string;
  notificationId: string;
  channel: NotificationChannel;
  status: "pending" | "delivered" | "failed" | "skipped";
  attempts: number;
}

export interface OutboxResult {
  status: "delivered" | "failed" | "skipped" | "pending";
  error?: string;
  providerRef?: string;
  availableAt?: Date;
}

export interface NotificationStore {
  ingest(drafts: NotificationDraft[]): Promise<Notification[]>;
  list(recipientId: string, options: { limit: number; offset: number; unreadOnly: boolean }): Promise<NotificationListResponse>;
  markRead(recipientId: string, ids: string[], readAt: Date): Promise<number>;
  pendingOutbox(notificationId: string): Promise<OutboxRow[]>;
  recordOutbox(id: string, result: OutboxResult): Promise<void>;
}
