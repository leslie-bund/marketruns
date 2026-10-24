import { z } from "zod";
import { PriceBandSchema, QuantitySchema, TimestampSchema } from "./primitives.js";

export const IntentStatusSchema = z.enum(["open", "matched"]);
export type IntentStatus = z.infer<typeof IntentStatusSchema>;

/** A buyer's expression of demand, matched to Stores whose Shop Items fit it. */
export const IntentSchema = z.object({
  id: z.string().min(1),
  shopItem: z.string().min(1),
  quantity: QuantitySchema,
  unit: z.string().min(1),
  priceBand: PriceBandSchema,
  note: z.string().optional(),
  market: z.string().min(1),
  createdAt: TimestampSchema,
  status: IntentStatusSchema,
  /** Client-supplied buyer identity until participant auth lands on the wire. */
  buyerId: z.string().min(1).optional(),
});
export type Intent = z.infer<typeof IntentSchema>;

/** Buyer → edge: post an Intent. `intentId` is the client idempotency key. */
export const IntentPostedSchema = z.object({
  type: z.literal("intent.posted"),
  intentId: z.string().min(1),
  shopItem: z.string().min(1),
  quantity: QuantitySchema,
  unit: z.string().min(1),
  priceBand: PriceBandSchema,
  note: z.string().optional(),
  market: z.string().min(1),
  /** Echoed from the posted intent; absent → the wire carried no buyer identity. */
  buyerId: z.string().min(1).optional(),
});
export type IntentPosted = z.infer<typeof IntentPostedSchema>;

/** Edge → buyer: the posted Intent is live with its 30-min TTL. */
export const IntentRecordedSchema = z.object({
  type: z.literal("intent.recorded"),
  intent: IntentSchema,
});
export type IntentRecorded = z.infer<typeof IntentRecordedSchema>;

/** Edge → buyer: the Intent's TTL lapsed; it can no longer be matched. */
export const IntentExpiredSchema = z.object({
  type: z.literal("intent.expired"),
  intentId: z.string().min(1),
  expiredAt: TimestampSchema,
  /** Trusted server-side attribution for notification delivery; absent on legacy anonymous intents. */
  buyerId: z.string().min(1).optional(),
});
export type IntentExpired = z.infer<typeof IntentExpiredSchema>;
