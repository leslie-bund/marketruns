import type { NotificationTransition } from "@market-runs/proto";

/** Trusted payment transition sink. No notification input participates in money decisions. */
export type PaymentNotificationSink = (transition: NotificationTransition) => Promise<void>;

export function queuePaymentNotifications(queue?: Queue): PaymentNotificationSink {
  return async (transition) => {
    if (queue) await queue.send(transition);
  };
}

export function paymentNotification(input: {
  sourceEventId: string;
  sourceEventType: string;
  recipientId: string;
  title: string;
  body: string;
  runId?: string;
  cartId?: string;
  status: string;
  deepLink?: string;
  occurredAt?: number;
}): NotificationTransition {
  return {
    sourceEventId: input.sourceEventId,
    sourceEventType: input.sourceEventType,
    recipientId: input.recipientId,
    dedupeKey: `${input.sourceEventId}:${input.recipientId}`,
    category: "payment",
    title: input.title,
    body: input.body,
    deepLink: input.deepLink ?? (input.runId ? `/buyer/run?runId=${encodeURIComponent(input.runId)}` : "/buyer/cart"),
    data: {
      status: input.status,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.cartId ? { cartId: input.cartId } : {}),
    },
    occurredAt: input.occurredAt ?? Date.now(),
    email: "receipt",
  };
}
