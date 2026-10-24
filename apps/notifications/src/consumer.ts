import { NotificationQueueMessageSchema, type NotificationQueueMessage } from "@market-runs/proto";
import type { NotificationDraft } from "./drafts.js";
import { mapServerEvent } from "./mapper.js";
import type { NotificationProviders } from "./provider.js";
import type { NotificationStore } from "./store.js";

export interface QueueMessageLike {
  id: string;
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export function retryDelaySeconds(attempts: number): number {
  return Math.min(15 * 2 ** Math.max(0, attempts - 1), 300);
}

export function parseNotificationMessage(body: unknown): NotificationQueueMessage {
  const raw = typeof body === "string" ? JSON.parse(body) : body;
  return NotificationQueueMessageSchema.parse(raw);
}

export function draftsForMessage(message: NotificationQueueMessage): NotificationDraft[] {
  return "recipientId" in message ? [message] : mapServerEvent(message.sourceEventId, message.occurredAt, message.event);
}

/** Durable insert happens before any external send; replays drain the same pending outbox rows. */
export async function consumeNotificationMessage(
  store: NotificationStore,
  providers: NotificationProviders,
  message: QueueMessageLike,
  maxAttempts = 5,
): Promise<void> {
  let parsed: NotificationQueueMessage;
  try {
    parsed = parseNotificationMessage(message.body);
  } catch (error) {
    console.error(JSON.stringify({ event: "notification.dead_letter", messageId: message.id, error: String(error) }));
    message.ack();
    return;
  }

  try {
    const notifications = await store.ingest(draftsForMessage(parsed));
    for (const notification of notifications) {
      const rows = await store.pendingOutbox(notification.id);
      for (const row of rows) {
        const result = row.channel === "email" ? await providers.email(notification) : await providers.websocket(notification);
        if (result.kind === "retry") {
          if (row.attempts + 1 >= maxAttempts) {
            await store.recordOutbox(row.id, { status: "failed", error: result.error });
            continue;
          }
          const delaySeconds = retryDelaySeconds(row.attempts + 1);
          await store.recordOutbox(row.id, {
            status: "pending",
            error: result.error,
            availableAt: new Date(Date.now() + delaySeconds * 1000),
          });
          message.retry({ delaySeconds });
          return;
        }
        await store.recordOutbox(row.id, {
          status: result.kind,
          ...("error" in result ? { error: result.error } : {}),
          ...(result.kind === "delivered" && result.providerRef ? { providerRef: result.providerRef } : {}),
        });
      }
    }
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({ event: "notification.consume_error", messageId: message.id, error: String(error) }));
    message.retry({ delaySeconds: 15 });
  }
}
