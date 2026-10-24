import { z } from "zod";
import { TimestampSchema } from "./primitives.js";
import { ParticipantRoleSchema } from "./participant.js";

/** Identity wire contracts. Raw captures are transit-only base64 JPEG. */
const ImagePayloadSchema = z.string().min(1).max(12_000_000);
const CaptureFramesSchema = z.array(ImagePayloadSchema).min(6).max(8);
const ParticipantIdSchema = z.string().min(1).max(128);
const ProofSchema = z.string().min(32).max(256);

export const BIOMETRIC_CONSENT_VERSION = "biometric-capture-v1";
export const BiometricConsentSchema = z.object({
  version: z.literal(BIOMETRIC_CONSENT_VERSION),
  granted: z.literal(true),
  grantedAt: TimestampSchema,
});
export type BiometricConsent = z.infer<typeof BiometricConsentSchema>;

export const SimilarityBucketSchema = z.enum(["low", "medium", "high"]);
export type SimilarityBucketWire = z.infer<typeof SimilarityBucketSchema>;

export const FaceUserDetailsSchema = z.object({
  givenNames: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().min(1).optional(),
});
export type FaceUserDetails = z.infer<typeof FaceUserDetailsSchema>;

/** Edge-only proof issuance. Staging may issue preverified; production requires verified. */
export const EnrollmentProofRequestSchema = z.object({
  participantId: ParticipantIdSchema,
  role: ParticipantRoleSchema,
  displayName: z.string().trim().min(1).max(120),
  kycStatus: z.enum(["preverified", "verified"]),
});
export type EnrollmentProofRequest = z.infer<typeof EnrollmentProofRequestSchema>;
export const EnrollmentProofResponseSchema = z.object({
  participantId: ParticipantIdSchema,
  enrollmentProof: ProofSchema,
  kycStatus: z.enum(["preverified", "verified"]),
  displayName: z.string(),
  verifiedLegalName: z.string().nullable(),
  expiresAt: TimestampSchema,
});
export type EnrollmentProofResponse = z.infer<typeof EnrollmentProofResponseSchema>;

export const IdentityDocumentSchema = z.object({
  country: z.string().length(2),
  idType: z.enum(["BVN", "NIN"]),
  idNumber: z.string().regex(/^\d{11}$/),
});
export type IdentityDocument = z.infer<typeof IdentityDocumentSchema>;

export const EnrollFaceRequestSchema = z.object({
  participantId: ParticipantIdSchema,
  enrollmentProof: ProofSchema,
  image: ImagePayloadSchema,
  livenessImages: CaptureFramesSchema,
  consent: BiometricConsentSchema,
  userDetails: FaceUserDetailsSchema.optional(),
  identityDocument: IdentityDocumentSchema.optional(),
});
export type EnrollFaceRequest = z.infer<typeof EnrollFaceRequestSchema>;
export const EnrollFaceResponseSchema = z.object({
  participantId: ParticipantIdSchema,
  enrolled: z.literal(true),
  modelVersion: z.string(),
  enrolledAt: TimestampSchema,
});
export type EnrollFaceResponse = z.infer<typeof EnrollFaceResponseSchema>;

export const VerifyFaceRequestSchema = z.object({
  participantId: ParticipantIdSchema,
  image: ImagePayloadSchema,
  livenessImages: CaptureFramesSchema,
  consent: BiometricConsentSchema,
});
export type VerifyFaceRequest = z.infer<typeof VerifyFaceRequestSchema>;

export const SessionSchema = z.object({ token: z.string(), tokenId: z.string(), expiresAt: TimestampSchema });
export type Session = z.infer<typeof SessionSchema>;
export const VerifyFaceResponseSchema = z.object({
  participantId: ParticipantIdSchema,
  verified: z.literal(true),
  session: SessionSchema,
});
export type VerifyFaceResponse = z.infer<typeof VerifyFaceResponseSchema>;

export const FaceJobKindSchema = z.enum(["enrollment", "authentication"]);
export type FaceJobKind = z.infer<typeof FaceJobKindSchema>;
export const FaceJobStatusSchema = z.enum(["pending", "complete", "failed", "expired"]);
export type FaceJobStatus = z.infer<typeof FaceJobStatusSchema>;
export const FaceJobSubmittedResponseSchema = z.object({
  participantId: ParticipantIdSchema,
  kind: FaceJobKindSchema,
  status: z.literal("pending"),
  jobId: z.string(),
  submittedAt: TimestampSchema,
  expiresAt: TimestampSchema,
});
export type FaceJobSubmittedResponse = z.infer<typeof FaceJobSubmittedResponseSchema>;
export const FaceJobStatusResponseSchema = z.object({
  jobId: z.string(),
  participantId: ParticipantIdSchema,
  kind: FaceJobKindSchema,
  status: FaceJobStatusSchema,
  session: SessionSchema.optional(),
  suggestedDisplayName: z.string().optional(),
  verifiedLegalName: z.string().optional(),
  completedAt: TimestampSchema.nullable(),
});
export type FaceJobStatusResponse = z.infer<typeof FaceJobStatusResponseSchema>;

export const SessionTokenPayloadSchema = z.object({
  tokenId: z.string(), participantId: ParticipantIdSchema, role: ParticipantRoleSchema,
  iat: TimestampSchema, exp: TimestampSchema,
});
export type SessionTokenPayload = z.infer<typeof SessionTokenPayloadSchema>;
export const ValidateSessionRequestSchema = z.object({ token: z.string().min(1) });
export type ValidateSessionRequest = z.infer<typeof ValidateSessionRequestSchema>;
export const ValidateSessionResponseSchema = z.object({ valid: z.literal(true), payload: SessionTokenPayloadSchema });
export type ValidateSessionResponse = z.infer<typeof ValidateSessionResponseSchema>;

export const CredentialTypeSchema = z.enum(["fido", "device-key"]);
export type CredentialType = z.infer<typeof CredentialTypeSchema>;
export const RegisterDeviceKeyRequestSchema = z.object({
  participantId: ParticipantIdSchema,
  credentialType: CredentialTypeSchema,
  secret: z.string().min(1).optional(),
  publicKey: z.string().min(1).optional(),
  deviceLabel: z.string().min(1).max(120).optional(),
  enrollmentProof: ProofSchema.optional(),
  recoveryProof: ProofSchema.optional(),
});
export type RegisterDeviceKeyRequest = z.infer<typeof RegisterDeviceKeyRequestSchema>;
export const RegisterDeviceKeyResponseSchema = z.object({
  credentialId: z.string(), participantId: ParticipantIdSchema, credentialType: CredentialTypeSchema, createdAt: TimestampSchema,
});
export type RegisterDeviceKeyResponse = z.infer<typeof RegisterDeviceKeyResponseSchema>;
export const AuthenticateDeviceKeyRequestSchema = z.object({
  participantId: ParticipantIdSchema, credentialId: z.string().min(1), secret: z.string().min(1),
});
export type AuthenticateDeviceKeyRequest = z.infer<typeof AuthenticateDeviceKeyRequestSchema>;
export const AuthenticateDeviceKeyResponseSchema = z.object({
  participantId: ParticipantIdSchema, authenticated: z.literal(true), session: SessionSchema,
});
export type AuthenticateDeviceKeyResponse = z.infer<typeof AuthenticateDeviceKeyResponseSchema>;

/** Self-service recovery: participant id + fresh liveness + 1:1 match. No email or 1:N search. */
export const RecoverDeviceRequestSchema = z.object({
  participantId: ParticipantIdSchema,
  image: ImagePayloadSchema,
  livenessImages: CaptureFramesSchema,
  consent: BiometricConsentSchema,
  credentialType: z.literal("device-key"),
  secret: z.string().min(32),
  deviceLabel: z.string().min(1).max(120).optional(),
});
export type RecoverDeviceRequest = z.infer<typeof RecoverDeviceRequestSchema>;
export const RecoverDeviceResponseSchema = z.object({
  participantId: ParticipantIdSchema,
  recovered: z.literal(true),
  credentialId: z.string(),
  session: SessionSchema,
});
export type RecoverDeviceResponse = z.infer<typeof RecoverDeviceResponseSchema>;

export const DisplayNameRequestSchema = z.object({ displayName: z.string().trim().min(1).max(120) });
export type DisplayNameRequest = z.infer<typeof DisplayNameRequestSchema>;
export const ParticipantIdentityResponseSchema = z.object({
  participantId: ParticipantIdSchema,
  displayName: z.string(),
  verifiedLegalName: z.string().nullable(),
  kycStatus: z.enum(["preverified", "verified"]),
});
export type ParticipantIdentityResponse = z.infer<typeof ParticipantIdentityResponseSchema>;

export const DeviceResetStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type DeviceResetStatus = z.infer<typeof DeviceResetStatusSchema>;
export const DeviceResetRequestSchema = z.object({ participantId: ParticipantIdSchema, reason: z.string().min(1) });
export type DeviceResetRequest = z.infer<typeof DeviceResetRequestSchema>;
export const DeviceResetResponseSchema = z.object({
  id: z.string(), participantId: ParticipantIdSchema, status: DeviceResetStatusSchema,
  createdAt: TimestampSchema, resolvedAt: TimestampSchema.nullable(),
});
export type DeviceResetResponse = z.infer<typeof DeviceResetResponseSchema>;
export const DeviceResetDecisionRequestSchema = z.object({
  decision: z.enum(["approved", "rejected"]), revokeSessions: z.boolean().optional(),
});
export type DeviceResetDecisionRequest = z.infer<typeof DeviceResetDecisionRequestSchema>;
export const DeviceResetViewSchema = DeviceResetResponseSchema.extend({ reason: z.string(), resolvedBy: z.string().nullable() });
export type DeviceResetView = z.infer<typeof DeviceResetViewSchema>;
export const DeviceResetListResponseSchema = z.object({ requests: z.array(DeviceResetViewSchema) });
export type DeviceResetListResponse = z.infer<typeof DeviceResetListResponseSchema>;

export const AuthErrorCodeSchema = z.enum([
  "invalid-request", "unauthorized-internal", "unauthorized-proof", "proof-expired", "proof-consumed",
  "face-not-enrolled", "face-mismatch", "liveness-failed", "too-many-attempts", "no-credential",
  "credential-revoked", "credential-exists", "fido-not-implemented", "session-invalid", "session-expired",
  "reset-not-found", "reset-already-resolved", "identity-unavailable", "bad-identity-response", "job-not-found",
  "job-expired", "callback-invalid", "enrollment-provider-mismatch", "kyc-required", "consent-required",
]);
export type AuthErrorCode = z.infer<typeof AuthErrorCodeSchema>;
export const AuthErrorSchema = z.object({
  error: AuthErrorCodeSchema, message: z.string(), similarityBucket: SimilarityBucketSchema.optional(),
});
export type AuthError = z.infer<typeof AuthErrorSchema>;
