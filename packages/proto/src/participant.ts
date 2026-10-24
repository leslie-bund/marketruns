import { z } from "zod";
import { TimestampSchema } from "./primitives.js";
import { KycVerificationStatusSchema } from "./payments.js";

/**
 * Participant identity (ADR-0004 universal KYC, ADR-0015 auth seam). Every
 * participant — buyer, seller, runner — onboards with a BVN or NIN plus a
 * facial capture before transacting. Vendor neutrality (ADR-0009): the wire
 * speaks in verifications and documents, never in any KYC vendor's shapes.
 */
export const ParticipantRoleSchema = z.enum(["buyer", "seller", "runner"]);
export type ParticipantRole = z.infer<typeof ParticipantRoleSchema>;

/** Nigerian identity document families accepted at onboarding. */
export const IdDocumentTypeSchema = z.enum(["bvn", "nin"]);
export type IdDocumentType = z.infer<typeof IdDocumentTypeSchema>;

export const ParticipantSchema = z.object({
  id: z.string().min(1),
  role: ParticipantRoleSchema,
  displayName: z.string().min(1),
  /** Receipts/security only; never an account-recovery channel. */
  email: z.string().email().optional(),
  verifiedLegalName: z.string().min(1).optional(),
  kycStatus: KycVerificationStatusSchema,
  idDocumentType: IdDocumentTypeSchema,
  /** Keyed HMAC-SHA256 of the document number — the raw BVN/NIN is never stored. */
  idDocumentHash: z.string().min(1),
  consentAt: TimestampSchema.optional(),
  consentVersion: z.string().min(1).optional(),
  /** Signed R2 reference of the onboarding facial capture. */
  facialCaptureRef: z.string().min(1).optional(),
  /** Markets this participant has joined. */
  markets: z.array(z.string().min(1)),
  createdAt: TimestampSchema,
});
export type Participant = z.infer<typeof ParticipantSchema>;

/**
 * Client → edge: onboard a participant. The raw document number is in transit
 * only — the edge verifies it through the identity-verifier seam and stores
 * its hash. `participantId` is the client idempotency key.
 */
export const ParticipantOnboardedSchema = z.object({
  type: z.literal("participant.onboarded"),
  participantId: z.string().min(1),
  role: ParticipantRoleSchema,
  displayName: z.string().min(1),
  email: z.string().email().optional(),
  verifiedLegalName: z.string().min(1).optional(),
  consentAt: TimestampSchema.optional(),
  consentVersion: z.string().min(1).optional(),
  idDocumentType: IdDocumentTypeSchema,
  idDocument: z.string().min(1),
  facialCaptureRef: z.string().min(1),
  /** The market the participant joins at onboarding. */
  market: z.string().min(1),
});
export type ParticipantOnboarded = z.infer<typeof ParticipantOnboardedSchema>;

/** Edge → participants: onboarding outcome (KYC verified or failed). */
export const ParticipantRecordedSchema = z.object({
  type: z.literal("participant.recorded"),
  participant: ParticipantSchema,
});
export type ParticipantRecorded = z.infer<typeof ParticipantRecordedSchema>;

/** Client → edge: join a market (all roles). Idempotent per participant. */
export const MarketJoinedSchema = z.object({
  type: z.literal("market.joined"),
  market: z.string().min(1),
  participantId: z.string().min(1),
  role: ParticipantRoleSchema,
});
export type MarketJoined = z.infer<typeof MarketJoinedSchema>;

/** Edge → market: a participant joined; the markets index learned the zone. */
export const MarketMemberRecordedSchema = z.object({
  type: z.literal("market.member-recorded"),
  market: z.string().min(1),
  participantId: z.string().min(1),
  role: ParticipantRoleSchema,
  joinedAt: TimestampSchema,
});
export type MarketMemberRecorded = z.infer<typeof MarketMemberRecordedSchema>;
