import { z } from "zod";
import { KoboSchema, TimestampSchema } from "./primitives.js";

/**
 * Payments and KYC speak in captures, holds, releases, and verifications
 * only — no vendor names, no vendor API shapes (ADR-0009). Switching or
 * dual-homing a provider is an integration-layer change, never a wire change.
 */

/** Edge → buyer: funds earmarked for a Cart/Run are held. */
export const PaymentHoldPlacedSchema = z.object({
  type: z.literal("payment.hold-placed"),
  holdId: z.string().min(1),
  amountKobo: KoboSchema,
  placedAt: TimestampSchema,
});
export type PaymentHoldPlaced = z.infer<typeof PaymentHoldPlacedSchema>;

/** Edge → participants (via settlement): held funds captured against a hold. */
export const PaymentFundsCapturedSchema = z.object({
  type: z.literal("payment.funds-captured"),
  captureId: z.string().min(1),
  holdId: z.string().min(1).optional(),
  amountKobo: KoboSchema,
  capturedAt: TimestampSchema,
});
export type PaymentFundsCaptured = z.infer<typeof PaymentFundsCapturedSchema>;

/** Edge → buyer: held funds released back (refunds flow only through settlement, ADR-0007). */
export const PaymentFundsReleasedSchema = z.object({
  type: z.literal("payment.funds-released"),
  releaseId: z.string().min(1),
  holdId: z.string().min(1).optional(),
  amountKobo: KoboSchema,
  releasedAt: TimestampSchema,
});
export type PaymentFundsReleased = z.infer<typeof PaymentFundsReleasedSchema>;

export const KycVerificationStatusSchema = z.enum(["pending", "verified", "failed"]);
export type KycVerificationStatus = z.infer<typeof KycVerificationStatusSchema>;

/** Edge → participant: identity verification outcome. */
export const KycVerificationResultSchema = z.object({
  type: z.literal("kyc.verification-result"),
  verificationId: z.string().min(1),
  status: KycVerificationStatusSchema,
  verifiedAt: TimestampSchema.optional(),
});
export type KycVerificationResult = z.infer<typeof KycVerificationResultSchema>;
