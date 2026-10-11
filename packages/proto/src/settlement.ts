import { z } from "zod";
import { KoboSchema, TimestampSchema } from "./primitives.js";

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
  mode: SettlementModeSchema,
  sellers: z.array(SellerSettlementSchema),
  runnerKobo: KoboSchema,
  platformKobo: KoboSchema,
  buyerRefundKobo: KoboSchema,
  platformLossKobo: KoboSchema,
  releasedAt: TimestampSchema,
});
export type SettlementReleased = z.infer<typeof SettlementReleasedSchema>;
