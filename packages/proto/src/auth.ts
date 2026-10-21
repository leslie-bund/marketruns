import { z } from "zod";
import { TimestampSchema } from "./primitives.js";
import { ParticipantRoleSchema } from "./participant.js";

/**
 * Identity/auth wire shapes (apps/identity worker; the edge proxies /auth/*).
 *
 * Onboarding doctrine: KYC → facial enrollment → passwordless thereafter
 * (ADR-0004/0009/0016). Face verification and the device-credential seam are
 * vendor-neutral: the wire speaks in enrollments, verifications, sessions,
 * and credentials — never in any biometric or FIDO vendor's shapes.
 * Timestamps are epoch ms (wire convention, primitives.ts).
 *
 * Raw images travel as base64 JPEG in transit only; the identity worker
 * stores the derived embedding (AES-256-GCM encrypted), never the image.
 */

/** base64-encoded JPEG capture. 8 MB wire cap is enforced at the edge. */
const ImagePayloadSchema = z.string().min(1);

/** Banded similarity — the raw score is NEVER on the wire (no score oracle). */
export const SimilarityBucketSchema = z.enum(["low", "medium", "high"]);
export type SimilarityBucketWire = z.infer<typeof SimilarityBucketSchema>;

/** Consumer-stated PII some vendors require at enrollment/verify time. */
export const FaceUserDetailsSchema = z.object({
  givenNames: z.string().min(1),
  lastName: z.string().min(1),
  /** At least one of email / phone should be present for vendor flows. */
  email: z.string().email().optional(),
  phone: z.string().min(1).optional(),
});
export type FaceUserDetails = z.infer<typeof FaceUserDetailsSchema>;

/* ------------------------------------------------------------------------ */
/* Face enrollment + verification                                            */
/* ------------------------------------------------------------------------ */

/**
 * Edge → identity: enroll a face after onboarding KYC has passed. The edge
 * asserts `role`; the identity worker trusts that assertion only over the
 * internal seam (dev-stage trust, see apps/identity README notes).
 */
export const EnrollFaceRequestSchema = z.object({
  participantId: z.string().min(1),
  role: ParticipantRoleSchema,
  image: ImagePayloadSchema,
  /**
   * Optional liveness sequence frames (base64 JPEG). The self-held embedding
   * path ignores them; async vendor paths forward them (a real provider
   * requires 6–8 frames — when omitted, the integration layer falls back and
   * says so in its report).
   */
  livenessImages: z.array(ImagePayloadSchema).max(8).optional(),
  /** Consumer-stated PII forwarded to vendor enrollment when required. */
  userDetails: FaceUserDetailsSchema.optional(),
});
export type EnrollFaceRequest = z.infer<typeof EnrollFaceRequestSchema>;

export const EnrollFaceResponseSchema = z.object({
  participantId: z.string().min(1),
  enrolled: z.literal(true),
  /** Embedding model version recorded with the enrollment (vendor-neutral). */
  modelVersion: z.string().min(1),
  enrolledAt: TimestampSchema,
});
export type EnrollFaceResponse = z.infer<typeof EnrollFaceResponseSchema>;

/** Client → identity (via edge proxy): passwordless login by face. */
export const VerifyFaceRequestSchema = z.object({
  participantId: z.string().min(1),
  image: ImagePayloadSchema,
  /** Optional liveness frames — see EnrollFaceRequestSchema. */
  livenessImages: z.array(ImagePayloadSchema).max(8).optional(),
  userDetails: FaceUserDetailsSchema.optional(),
});
export type VerifyFaceRequest = z.infer<typeof VerifyFaceRequestSchema>;

export const SessionSchema = z.object({
  token: z.string().min(1),
  tokenId: z.string().min(1),
  expiresAt: TimestampSchema,
});
export type Session = z.infer<typeof SessionSchema>;

export const VerifyFaceResponseSchema = z.object({
  participantId: z.string().min(1),
  verified: z.literal(true),
  session: SessionSchema,
});
export type VerifyFaceResponse = z.infer<typeof VerifyFaceResponseSchema>;

/* ------------------------------------------------------------------------ */
/* Async face jobs (vendor-held biometrics, e.g. SmartSelfie-style flows)    */
/* ------------------------------------------------------------------------ */

/**
 * When the active face provider processes enroll/verify as an async job, the
 * enroll/verify endpoints answer 202 with this shape instead of their
 * synchronous 200 shape; the client polls GET /auth/face/job/:jobId.
 */
export const FaceJobKindSchema = z.enum(["enrollment", "authentication"]);
export type FaceJobKind = z.infer<typeof FaceJobKindSchema>;

export const FaceJobStatusSchema = z.enum(["pending", "complete", "failed"]);
export type FaceJobStatus = z.infer<typeof FaceJobStatusSchema>;

export const FaceJobSubmittedResponseSchema = z.object({
  participantId: z.string().min(1),
  kind: FaceJobKindSchema,
  status: z.literal("pending"),
  /** Identity-worker job id — the polling key, NOT the provider's job id. */
  jobId: z.string().min(1),
  submittedAt: TimestampSchema,
});
export type FaceJobSubmittedResponse = z.infer<typeof FaceJobSubmittedResponseSchema>;

export const FaceJobStatusResponseSchema = z.object({
  jobId: z.string().min(1),
  participantId: z.string().min(1),
  kind: FaceJobKindSchema,
  status: FaceJobStatusSchema,
  /** Present only when kind=authentication and status=complete. */
  session: SessionSchema.optional(),
  completedAt: TimestampSchema.nullable(),
});
export type FaceJobStatusResponse = z.infer<typeof FaceJobStatusResponseSchema>;

/* ------------------------------------------------------------------------ */
/* Sessions                                                                  */
/* ------------------------------------------------------------------------ */

/** The payload inside a signed session token (compact HMAC-SHA256, 12h TTL). */
export const SessionTokenPayloadSchema = z.object({
  tokenId: z.string().min(1),
  participantId: z.string().min(1),
  role: ParticipantRoleSchema,
  iat: TimestampSchema,
  exp: TimestampSchema,
});
export type SessionTokenPayload = z.infer<typeof SessionTokenPayloadSchema>;

export const ValidateSessionRequestSchema = z.object({
  token: z.string().min(1),
});
export type ValidateSessionRequest = z.infer<typeof ValidateSessionRequestSchema>;

export const ValidateSessionResponseSchema = z.object({
  valid: z.literal(true),
  payload: SessionTokenPayloadSchema,
});
export type ValidateSessionResponse = z.infer<typeof ValidateSessionResponseSchema>;

/* ------------------------------------------------------------------------ */
/* Device credentials (keychain seam + FIDO/passkey seam)                    */
/* ------------------------------------------------------------------------ */

export const CredentialTypeSchema = z.enum(["fido", "device-key"]);
export type CredentialType = z.infer<typeof CredentialTypeSchema>;

/**
 * Register a device-bound credential — the fallback login when face
 * verification is unavailable or declined.
 *
 * - `device-key`: an opaque secret generated on the device (keychain-backed).
 *   Only its SHA-256 hash is stored.
 * - `fido`: a WebAuthn registration. STUB seam — real attestation
 *   verification is deliberately TODO-real-vendor; dev-only gated
 *   (apps/identity). `publicKey` carries the credential public key.
 */
export const RegisterDeviceKeyRequestSchema = z.object({
  participantId: z.string().min(1),
  credentialType: CredentialTypeSchema,
  /** Required for device-key (hashed at rest); for fido carries the public key. */
  secret: z.string().min(1).optional(),
  publicKey: z.string().min(1).optional(),
  deviceLabel: z.string().min(1).optional(),
});
export type RegisterDeviceKeyRequest = z.infer<typeof RegisterDeviceKeyRequestSchema>;

export const RegisterDeviceKeyResponseSchema = z.object({
  credentialId: z.string().min(1),
  participantId: z.string().min(1),
  credentialType: CredentialTypeSchema,
  createdAt: TimestampSchema,
});
export type RegisterDeviceKeyResponse = z.infer<typeof RegisterDeviceKeyResponseSchema>;

/** Fallback login with a device credential; on pass, issues a session. */
export const AuthenticateDeviceKeyRequestSchema = z.object({
  participantId: z.string().min(1),
  credentialId: z.string().min(1),
  /** The device-key secret, or a fido assertion payload (stub seam). */
  secret: z.string().min(1),
});
export type AuthenticateDeviceKeyRequest = z.infer<typeof AuthenticateDeviceKeyRequestSchema>;

export const AuthenticateDeviceKeyResponseSchema = z.object({
  participantId: z.string().min(1),
  authenticated: z.literal(true),
  session: SessionSchema,
});
export type AuthenticateDeviceKeyResponse = z.infer<typeof AuthenticateDeviceKeyResponseSchema>;

/* ------------------------------------------------------------------------ */
/* Device reset (dispute-like flow: request → ops decision → revoke)         */
/* ------------------------------------------------------------------------ */

export const DeviceResetStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type DeviceResetStatus = z.infer<typeof DeviceResetStatusSchema>;

export const DeviceResetRequestSchema = z.object({
  participantId: z.string().min(1),
  reason: z.string().min(1),
});
export type DeviceResetRequest = z.infer<typeof DeviceResetRequestSchema>;

export const DeviceResetResponseSchema = z.object({
  id: z.string().min(1),
  participantId: z.string().min(1),
  status: DeviceResetStatusSchema,
  createdAt: TimestampSchema,
  resolvedAt: TimestampSchema.nullable(),
});
export type DeviceResetResponse = z.infer<typeof DeviceResetResponseSchema>;

/** Ops → identity: approve or reject a pending reset (internal seam). */
export const DeviceResetDecisionRequestSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  /** Also revoke live sessions on approval (default true — a lost device means its sessions are suspect). */
  revokeSessions: z.boolean().optional(),
});
export type DeviceResetDecisionRequest = z.infer<typeof DeviceResetDecisionRequestSchema>;

/**
 * One device-reset request as the ops console reads it (internal seam):
 * the public response fields plus the stated reason and who resolved it.
 */
export const DeviceResetViewSchema = DeviceResetResponseSchema.extend({
  reason: z.string(),
  resolvedBy: z.string().nullable(),
});
export type DeviceResetView = z.infer<typeof DeviceResetViewSchema>;

/** Identity → ops console: the device-reset queue (GET /auth/device-reset?status=pending). */
export const DeviceResetListResponseSchema = z.object({
  requests: z.array(DeviceResetViewSchema),
});
export type DeviceResetListResponse = z.infer<typeof DeviceResetListResponseSchema>;

/* ------------------------------------------------------------------------ */
/* Errors                                                                    */
/* ------------------------------------------------------------------------ */

export const AuthErrorCodeSchema = z.enum([
  "invalid-request",
  "unauthorized-internal",
  "face-not-enrolled",
  "face-mismatch",
  "no-credential",
  "credential-revoked",
  "credential-exists",
  "fido-not-implemented",
  "session-invalid",
  "session-expired",
  "reset-not-found",
  "reset-already-resolved",
  "identity-unavailable",
  "bad-identity-response",
  /** Async face jobs: unknown job id, or a callback for a provider that isn't active. */
  "job-not-found",
  /** A vendor callback whose signature did not verify. */
  "callback-invalid",
  /** The stored enrollment belongs to a different provider mode than the active one. */
  "enrollment-provider-mismatch",
]);
export type AuthErrorCode = z.infer<typeof AuthErrorCodeSchema>;

export const AuthErrorSchema = z.object({
  error: AuthErrorCodeSchema,
  message: z.string(),
  /** Present only on face-mismatch: banded, never the raw score. */
  similarityBucket: SimilarityBucketSchema.optional(),
});
export type AuthError = z.infer<typeof AuthErrorSchema>;
