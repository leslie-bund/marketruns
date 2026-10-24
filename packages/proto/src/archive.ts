import { z } from "zod";
import { RequestIdSchema, TimestampSchema } from "./primitives.js";
import { ProductSchema } from "./negotiation.js";
import { CartSchema } from "./cart.js";
import { DeliverySchema, KoboSchema } from "./primitives.js";
import { RunHandoffSchema, RunStatusSchema, RunStopSchema } from "./run.js";
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
  /** The product's market and buyer (when the intent carried one) for archive attribution. */
  market: z.string().min(1).optional(),
  buyerId: z.string().min(1).optional(),
  /** Correlation id of the triggering request, when the retirement ran inside one. Append-only. */
  requestId: RequestIdSchema.optional(),
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
  /** Correlation id of the checkout request, when retirement ran inside one. Append-only. */
  requestId: RequestIdSchema.optional(),
});
export type CartRetired = z.infer<typeof CartRetiredSchema>;

/**
 * Run started — the RunDO announces a new live Run so the archive consumer can
 * maintain the live_runs index (admin ops dashboard). Carries the LiveRun
 * fields minus retiredAt; the row is marked retired on run.retired /
 * settlement.released.
 */
export const RunStartedSchema = z.object({
  type: z.literal("run.started"),
  runId: z.string().min(1),
  market: z.string().min(1),
  status: RunStatusSchema,
  /** NULL until a Runner is assigned (internal runner at the floor rate at MVP). */
  runnerId: z.string().min(1).nullable(),
  buyerId: z.string().min(1),
  startedAt: TimestampSchema,
  stopCount: z.number().int().nonnegative(),
  /**
   * The stores with products in this run's cart — one entry per distinct
   * store reference on the accepted Products. Products carry the store's
   * trading identity as `sellerName` (the same textual reference
   * archived_products.store_id records; migration 0001), so these are those
   * references, not registry ids. Powers seller run discovery.
   */
  storeIds: z.array(z.string().min(1)),
  /** Participant ids resolved from accepted products when available; storeIds are never treated as participants. */
  sellerParticipantIds: z.array(z.string().min(1)).optional(),
  /** Correlation id of the checkout request that started the run. Append-only. */
  requestId: RequestIdSchema.optional(),
});
export type RunStarted = z.infer<typeof RunStartedSchema>;

/** Immutable close record sent before settlement.released so its FK exists. */
export const RunRetiredSchema = z.object({
  type: z.literal("run.retired"),
  runId: z.string().min(1),
  cartId: z.string().min(1),
  market: z.string().min(1),
  /** Durable identities: the archive consumer anchors the run and ledger to these. */
  buyerId: z.string().min(1),
  runnerId: z.string().min(1),
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
  /**
   * The evidence layer, durable (ADR-0007): every handoff with its signed
   * photo reference and scan/confirm timestamps. Additive — archive consumers
   * written before this field existed simply ignore it.
   */
  handoffs: z.array(RunHandoffSchema).optional(),
  /**
   * Dispute context at close (when the run retired disputed): who raised it,
   * why, and the evidence references gathered at dispute time (handoff photo
   * refs plus any the raiser attached). This is what the archive's disputes
   * table (evidence_refs) is written from.
   */
  dispute: z
    .object({
      reason: z.string().min(1),
      raisedByParticipantId: z.string().min(1).nullable(),
      evidenceRefs: z.array(z.string().min(1)),
    })
    .optional(),
  /** Correlation id of the request that closed the run (final delivery / ops settle); absent on timer closes. Append-only. */
  requestId: RequestIdSchema.optional(),
});
export type RunRetired = z.infer<typeof RunRetiredSchema>;
