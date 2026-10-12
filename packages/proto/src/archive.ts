import { z } from "zod";
import { TimestampSchema } from "./primitives.js";
import { ProductSchema } from "./negotiation.js";
import { CartSchema } from "./cart.js";
import { DeliverySchema, KoboSchema } from "./primitives.js";
import { RunStatusSchema, RunStopSchema } from "./run.js";
import { SettlementModeSchema, SellerSettlementSchema } from "./settlement.js";

/**
 * Retirement = snapshot to Postgres/R2 via the archive queue, then delete DO
 * storage (ADR-0010). These payloads are what the DO puts on the queue and
 * what the archive consumer persists. Retired Products are never resurrected.
 */
export const ProductRetirementReasonSchema = z.enum(["sold", "expired", "withdrawn", "cart-retired"]);
export type ProductRetirementReason = z.infer<typeof ProductRetirementReasonSchema>;

/** Product retired (archive queue payload). */
export const ProductRetiredSchema = z.object({
  type: z.literal("product.retired"),
  productId: z.string().min(1),
  intentId: z.string().min(1),
  reason: ProductRetirementReasonSchema,
  retiredAt: TimestampSchema,
  snapshot: ProductSchema,
});
export type ProductRetired = z.infer<typeof ProductRetiredSchema>;

export const CartRetirementReasonSchema = z.enum(["deadline-expired", "checked-out", "aborted"]);
export type CartRetirementReason = z.infer<typeof CartRetirementReasonSchema>;

/** Cart retired — on deadline expiry every unbought Product retires together (ADR-0003). */
export const CartRetiredSchema = z.object({
  type: z.literal("cart.retired"),
  cartId: z.string().min(1),
  market: z.string().min(1),
  reason: CartRetirementReasonSchema,
  retiredAt: TimestampSchema,
  snapshot: CartSchema,
});
export type CartRetired = z.infer<typeof CartRetiredSchema>;

/** Immutable close record sent before settlement.released so its FK exists. */
export const RunRetiredSchema = z.object({
  type: z.literal("run.retired"),
  runId: z.string().min(1),
  cartId: z.string().min(1),
  market: z.string().min(1),
  status: RunStatusSchema,
  floorRateKobo: KoboSchema,
  delivery: DeliverySchema,
  stops: z.array(RunStopSchema),
  mode: SettlementModeSchema,
  settlementLegs: z.array(SellerSettlementSchema),
  runnerKobo: KoboSchema,
  platformKobo: KoboSchema,
  buyerRefundKobo: KoboSchema,
  platformLossKobo: KoboSchema,
  closedAt: TimestampSchema,
});
export type RunRetired = z.infer<typeof RunRetiredSchema>;
