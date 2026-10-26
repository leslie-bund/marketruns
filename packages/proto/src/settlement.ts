import { z } from "zod";
import { KoboSchema, RequestIdSchema, TimestampSchema } from "./primitives.js";

/**
 * The computation performed when a Run closes (GLOSSARY.md). All money
 * movement is expressed ONLY through this message — no ad-hoc transfers or
 * side-channel refunds (ADR-0007, ADR-0008). Amounts are integer kobo and
 * mirror `SettlementOutcome` in @market-runs/domain.
 */
export const SettlementModeSchema = z.enum(["completed", "aborted", "disputed"]);
export type SettlementMode = z.infer<typeof SettlementModeSchema>;

export const SellerSettlementSchema = z.object({
  sellerId: z.string().min(1),
  amountKobo: KoboSchema,
});
export type SellerSettlement = z.infer<typeof SellerSettlementSchema>;

/** Edge → participants (post dispute window): payment released per the mode's rules. */
export const SettlementReleasedSchema = z.object({
  type: z.literal("settlement.released"),
  runId: z.string().min(1),
  /** Durable identities for the ledger capture leg and reputation (archive consumer). */
  buyerId: z.string().min(1),
  runnerId: z.string().min(1),
  mode: SettlementModeSchema,
  sellers: z.array(SellerSettlementSchema),
  runnerKobo: KoboSchema,
  platformKobo: KoboSchema,
  buyerRefundKobo: KoboSchema,
  platformLossKobo: KoboSchema,
  releasedAt: TimestampSchema,
  /**
   * The full SettlementInput the settlement function was called with,
   * verbatim — the archive consumer stores this as settlement_records.inputs
   * so the durable record shows exactly what was computed and why (ADR-0011).
   */
  inputs: z.object({
    mode: SettlementModeSchema,
    sellers: z.array(z.object({
      sellerId: z.string().min(1),
      amountKobo: KoboSchema,
      stopCompleted: z.boolean(),
    })),
    deliveryPriceKobo: KoboSchema,
    deliveryMarginKobo: KoboSchema,
    goodsCommissionBps: z.number().int().min(0).max(10_000),
    abortSplit: z
      .object({
        disruptionCompensationBps: z.number().int().min(0).max(10_000),
        platformFeeBps: z.number().int().min(0).max(10_000),
        ambiguousLossCapKobo: KoboSchema.max(Number.MAX_SAFE_INTEGER),
      })
      .refine((split) => split.disruptionCompensationBps + split.platformFeeBps <= 10_000, {
        message: "disruptionCompensationBps + platformFeeBps must be <= 10000",
      })
      .optional(),
    dispute: z
      .object({ ambiguous: z.boolean(), requestedPlatformLossKobo: KoboSchema.optional() })
      .optional(),
  }),
  /** Correlation id of the request that released the settlement; absent on timer releases. Append-only. */
  requestId: RequestIdSchema.optional(),
});
export type SettlementReleased = z.infer<typeof SettlementReleasedSchema>;
