import { z } from "zod";
import { PaymentDispatchRequestedSchema, PaymentRefundRequestedSchema } from "@market-runs/proto";

export type { PaymentDispatchRequested, PaymentRefundRequested } from "@market-runs/proto";

/**
 * The payment queue carries two execution requests, both decided by the
 * settlement function upstream (ADR-0007/0008): payout legs
 * (payment.dispatch-requested) and buyer refunds against the hold
 * (payment.refund-requested, ADR-0023).
 */
export const PaymentQueueMessageSchema = z.discriminatedUnion("type", [
  PaymentDispatchRequestedSchema,
  PaymentRefundRequestedSchema,
]);
export type PaymentQueueMessage = z.infer<typeof PaymentQueueMessageSchema>;

/**
 * Queue bodies arrive as JSON strings (the edge serializes with
 * serializeEvent); accept both the string and the already-parsed object so
 * the consumer never dead-letters its own wire format.
 */
export function parsePaymentMessage(body: unknown) {
  if (typeof body === "string") {
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return PaymentQueueMessageSchema.safeParse(body);
    }
    return PaymentQueueMessageSchema.safeParse(raw);
  }
  return PaymentQueueMessageSchema.safeParse(body);
}
