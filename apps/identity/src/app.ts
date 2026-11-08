import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import {
  AuthenticateDeviceKeyRequestSchema, BIOMETRIC_CONSENT_VERSION, DeviceResetDecisionRequestSchema,
  DeviceResetRequestSchema, DeviceResetStatusSchema, DisplayNameRequestSchema, EnrollFaceRequestSchema,
  EnrollmentProofRequestSchema, IdentityKycResponseSchema, RecoverDeviceRequestSchema, RegisterDeviceKeyRequestSchema,
  ValidateSessionRequestSchema, VerifyFaceRequestSchema, type AuthErrorCode, type BiometricConsent,
  type IdentityKycRequest, type Session,
} from "@market-runs/proto";
import {
  DEFAULT_FACE_MATCH_THRESHOLD, SESSION_TOKEN_TTL_MS, cosineSimilarity, faceMatchPasses,
  signSessionToken, similarityBucket, verifySessionToken,
} from "@market-runs/domain";
import type { Env } from "./env.js";
import { encryptionKeyBase64, faceMatchThreshold, fidoUpsertEnabled, isDeployed, isProduction, sessionSecret } from "./env.js";
import { BiometricServiceError, isAsyncFaceVerifier, type AsyncFaceVerifier, type FaceCallbackVerdict, type FaceVerifier } from "./face-verifier.js";
import type { PasskeyVerifier } from "./passkey-verifier.js";
import type { FaceAuthJobRow, IdentityAccessProofRow, IdentityStore } from "./store.js";
import { base64ToBytes, decryptEmbedding, encryptEmbedding, sha256CaptureHex, sha256Hex } from "./crypto.js";
import {
  createR2CaptureStore, currentCaptureKey, pendingCaptureKey, type IdentityCaptureStore,
} from "./capture-store.js";

const PROOF_TTL_MS = 15 * 60_000;
const JOB_TTL_MS = 2 * 60_000;
const ATTEMPT_WINDOW_MS = 15 * 60_000;
const MAX_FAILED_ATTEMPTS = 5;
export type CoreKycReconciler = (env: Env, input: IdentityKycRequest) => Promise<void>;
export interface IdentityDeps {
  store: IdentityStore;
  faceVerifier: FaceVerifier | AsyncFaceVerifier;
  localFaceVerifier?: FaceVerifier;
  captureStore?: IdentityCaptureStore;
  passkeyVerifier: PasskeyVerifier | null;
  reconcileCoreKyc?: CoreKycReconciler;
  now?: () => Date;
}
function error(c: Context, status: number, code: AuthErrorCode, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ error: code, message, ...extra }, status as never);
}
function requireInternal(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const token = c.env.IDENTITY_INTERNAL_TOKEN;
    if (!token && isDeployed(c.env)) return error(c, 503, "identity-unavailable", "IDENTITY_INTERNAL_TOKEN is required in deployed identity");
    if (token && c.req.header("x-identity-internal") !== token) return error(c, 403, "unauthorized-internal", "valid internal token required");
    await next();
  };
}

/** Reconcile the core profile before completing the job; callback/poll retries remain idempotent. */
export async function reconcileCoreKyc(env: Env, input: IdentityKycRequest): Promise<void> {
  if (!env.EDGE_URL) {
    if (isDeployed(env)) throw new Error("EDGE_URL is required for core KYC reconciliation");
    return; // Local vendor tests may run without the edge; deployed staging never can.
  }
  if (!env.IDENTITY_INTERNAL_TOKEN) {
    if (isDeployed(env)) throw new Error("IDENTITY_INTERNAL_TOKEN is required for core KYC reconciliation");
    return;
  }
  const target = new URL("/internal/identity/kyc", env.EDGE_URL);
  const init = {
    method: "POST",
    headers: { "content-type": "application/json", "x-identity-internal": env.IDENTITY_INTERNAL_TOKEN },
    body: JSON.stringify(input),
    redirect: "error" as const,
  };
  const response = env.EDGE_SERVICE ? await env.EDGE_SERVICE.fetch(target, init) : await fetch(target, init);
  if (!response.ok) throw new Error(`core KYC reconciliation failed with status ${response.status}`);
  const recorded = IdentityKycResponseSchema.safeParse(await response.json().catch(() => null));
  if (!recorded.success || recorded.data.participant.id !== input.participantId || recorded.data.participant.kycStatus !== "verified") {
    throw new Error("core KYC reconciliation returned an invalid participant record");
  }
}
async function issueSession(store: IdentityStore, env: Env, participantId: string, role: string, now: Date): Promise<Session> {
  const tokenId = crypto.randomUUID(); const expiresAt = now.getTime() + SESSION_TOKEN_TTL_MS;
  const token = await signSessionToken({ tokenId, participantId, role, iat: now.getTime(), exp: expiresAt }, sessionSecret(env));
  await store.insertAuthSession({ tokenId, participantId, issuedAt: now, expiresAt: new Date(expiresAt), revokedAt: null });
  return { token, tokenId, expiresAt };
}
async function sessionForJob(store: IdentityStore, env: Env, job: FaceAuthJobRow, now: Date): Promise<Session | null> {
  if (job.sessionTokenId) {
    const row = await store.getAuthSession(job.sessionTokenId);
    if (!row || row.revokedAt) return null;
    const token = await signSessionToken({ tokenId: row.tokenId, participantId: row.participantId, role: job.role,
      iat: row.issuedAt.getTime(), exp: row.expiresAt.getTime() }, sessionSecret(env));
    return { token, tokenId: row.tokenId, expiresAt: row.expiresAt.getTime() };
  }
  const session = await issueSession(store, env, job.participantId, job.role, now);
  await store.setFaceAuthJobSession(job.id, session.tokenId); return session;
}
function decodeFrames(list: string[]): Uint8Array[] {
  return list.map((item) => { const bytes = base64ToBytes(item); if (!bytes?.length || bytes.length > 8 * 1024 * 1024) throw new Error("invalid capture"); return bytes; });
}
function randomProof(): string {
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
class ProofFailure extends Error { constructor(readonly code: AuthErrorCode, readonly status = 401) { super(code); } }
async function validProof(store: IdentityStore, raw: string, participantId: string, purpose: "enrollment" | "recovery", now: Date) {
  const proof = await store.getAccessProof(await sha256Hex(raw));
  if (!proof || proof.participantId !== participantId || proof.purpose !== purpose) throw new ProofFailure("unauthorized-proof");
  if (proof.consumedAt) throw new ProofFailure("proof-consumed", 409);
  if (proof.expiresAt <= now) throw new ProofFailure("proof-expired");
  return proof;
}
async function sessionParticipant(store: IdentityStore, env: Env, authorization: string | undefined, now: Date): Promise<string | null> {
  if (!authorization?.startsWith("Bearer ")) return null;
  const result = await verifySessionToken(authorization.slice(7), sessionSecret(env)); if (!result.ok) return null;
  const row = await store.getAuthSession(result.payload.tokenId);
  return row && !row.revokedAt && row.expiresAt > now ? row.participantId : null;
}
async function recordConsent(store: IdentityStore, participantId: string, purpose: string, consent: BiometricConsent, now: Date) {
  if (consent.version !== BIOMETRIC_CONSENT_VERSION || !consent.granted || consent.grantedAt > now.getTime() + 60_000 || consent.grantedAt < now.getTime() - PROOF_TTL_MS) {
    throw new ProofFailure("consent-required", 400);
  }
  await store.insertBiometricConsent({ id: crypto.randomUUID(), participantId, purpose, version: consent.version,
    grantedAt: new Date(consent.grantedAt), createdAt: now });
}
async function analyze(local: FaceVerifier, image: Uint8Array, frames: Uint8Array[]) {
  try { return await local.analyze(image, frames); }
  catch (cause) {
    if (cause instanceof BiometricServiceError && cause.status === 422) throw new ProofFailure("liveness-failed", 422);
    throw cause;
  }
}
async function checkAttempts(store: IdentityStore, participantId: string, now: Date) {
  if (await store.countRecentFaceFailures(participantId, new Date(now.getTime() - ATTEMPT_WINDOW_MS)) >= MAX_FAILED_ATTEMPTS) {
    throw new ProofFailure("too-many-attempts", 429);
  }
}
async function audit(store: IdentityStore, participantId: string, pass: boolean, bucket: "low" | "medium" | "high" | null, now: Date) {
  await store.insertFaceAuthAttempt({ id: crypto.randomUUID(), participantId, outcome: pass ? "pass" : "fail", similarityBucket: bucket, createdAt: now });
}
function pendingJob(id: string, participantId: string, role: string, providerJobId: string, now: Date,
  pending: { ciphertext: Uint8Array; iv: Uint8Array; authTag: Uint8Array }, modelVersion: string,
  capture: { key: string; sha256: string; consent: BiometricConsent }): FaceAuthJobRow {
  return { id, providerJobId, participantId, role, kind: "enrollment", status: "pending",
    failureReason: null, sessionTokenId: null, pendingEmbeddingEncrypted: pending.ciphertext,
    pendingEmbeddingIv: pending.iv, pendingEmbeddingAuthTag: pending.authTag, pendingModelVersion: modelVersion,
    pendingCaptureObjectKey: capture.key, pendingCaptureSha256: capture.sha256,
    pendingCaptureConsentVersion: capture.consent.version, pendingCaptureConsentGrantedAt: new Date(capture.consent.grantedAt),
    createdAt: now, expiresAt: new Date(now.getTime() + JOB_TTL_MS), completedAt: null };
}
async function failEnrollment(store: IdentityStore, captures: IdentityCaptureStore | null, job: FaceAuthJobRow,
  reason: string, now: Date): Promise<FaceAuthJobRow> {
  const pendingKey = job.pendingCaptureObjectKey;
  const completed = job.status === "pending" && await store.completeFaceAuthJob(job.id, "failed", reason, now);
  if (completed && pendingKey) await captures?.delete(pendingKey).catch(() => undefined);
  return (await store.getFaceAuthJob(job.id)) ?? { ...job, status: "failed", failureReason: reason, completedAt: now };
}
export async function cleanupExpiredEnrollmentCaptures(store: IdentityStore, captures: IdentityCaptureStore, now: Date): Promise<number> {
  const jobs = await store.listExpiredPendingFaceAuthJobs(now);
  for (const job of jobs) await failEnrollment(store, captures, job, "expired", now);
  return jobs.length;
}
async function finalizeEnrollment(store: IdentityStore, captures: IdentityCaptureStore | null, env: Env, job: FaceAuthJobRow,
  verdict: FaceCallbackVerdict, now: Date, reconcile: CoreKycReconciler): Promise<FaceAuthJobRow> {
  if (now >= job.expiresAt || job.status !== "pending") return failEnrollment(store, captures, job, "expired", now);
  if (!verdict.passed || verdict.userRef !== job.participantId) {
    return failEnrollment(store, captures, job, verdict.userRef !== job.participantId ? "participant-mismatch" : verdict.reason ?? "provider-rejected", now);
  }
  const encrypted = job.pendingEmbeddingEncrypted && job.pendingEmbeddingIv && job.pendingEmbeddingAuthTag ? {
    ciphertext: job.pendingEmbeddingEncrypted, iv: job.pendingEmbeddingIv, authTag: job.pendingEmbeddingAuthTag,
  } : null;
  const modelVersion = job.pendingModelVersion;
  const pendingKey = job.pendingCaptureObjectKey;
  if (!encrypted || !modelVersion || !captures || !pendingKey || !job.pendingCaptureSha256 ||
      !job.pendingCaptureConsentVersion || !job.pendingCaptureConsentGrantedAt) {
    return failEnrollment(store, captures, job, "missing-pending-enrollment-artifact", now);
  }
  const previous = await store.getFaceEnrollment(job.participantId);
  const retainedKey = currentCaptureKey(job.id);
  const alreadyPromoted = previous?.captureObjectKey === retainedKey && previous.captureSha256 === job.pendingCaptureSha256;
  if (!alreadyPromoted) {
    try {
      await captures.promote(pendingKey, retainedKey, job.pendingCaptureSha256);
    } catch {
      return failEnrollment(store, captures, job, "pending-capture-unavailable", now);
    }
  }
  let enrolled = false;
  try {
    await store.completeIdentityKyc(job.participantId, verdict.verifiedLegalName ?? null, now);
    await store.upsertFaceEnrollment({ participantId: job.participantId, role: job.role, embeddingEncrypted: encrypted.ciphertext,
      iv: encrypted.iv, authTag: encrypted.authTag, modelVersion, providerRef: job.participantId,
      captureObjectKey: retainedKey, captureSha256: job.pendingCaptureSha256,
      captureConsentVersion: job.pendingCaptureConsentVersion, captureConsentGrantedAt: job.pendingCaptureConsentGrantedAt,
      captureRetainedAt: now, createdAt: now, lastVerifiedAt: null });
    enrolled = true;
    // A failed core write leaves the job pending and the promoted capture intact;
    // a later signed callback or poll retries without requiring a new selfie.
    await reconcile(env, { participantId: job.participantId, verifiedLegalName: verdict.verifiedLegalName ?? null });
    await store.completeFaceAuthJob(job.id, "passed", null, now);
  } catch (cause) {
    if (!enrolled) await captures.delete(retainedKey).catch(() => undefined);
    throw cause;
  }
  if (previous?.captureObjectKey && previous.captureObjectKey !== retainedKey) {
    await captures.delete(previous.captureObjectKey).catch(() => undefined);
  }
  return (await store.getFaceAuthJob(job.id)) ?? { ...job, status: "passed", completedAt: now };
}

export function createIdentityApp(deps: IdentityDeps): Hono<{ Bindings: Env }> {
  const { store, faceVerifier, passkeyVerifier } = deps;
  const local = deps.localFaceVerifier ?? (isAsyncFaceVerifier(faceVerifier) ? null : faceVerifier);
  const reconcile = deps.reconcileCoreKyc ?? reconcileCoreKyc;
  const now = () => deps.now?.() ?? new Date();
  const app = new Hono<{ Bindings: Env }>();
  app.get("/healthz", (c) => c.json({ ok: true, service: "market-runs-identity" }));

  app.post("/auth/enrollment-proof", requireInternal(), async (c) => {
    const parsed = EnrollmentProofRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return error(c, 400, "invalid-request", "invalid proof request");
    if (isProduction(c.env) && parsed.data.kycStatus !== "verified") return error(c, 403, "kyc-required", "production enrollment requires verified KYC");
    const at = now(); const existing = await store.getIdentityParticipant(parsed.data.participantId);
    if (existing && existing.role !== parsed.data.role) return error(c, 409, "invalid-request", "participant role is already registered");
    const kycStatus = existing?.kycStatus === "verified" ? "verified" : parsed.data.kycStatus;
    await store.putIdentityParticipant({ participantId: parsed.data.participantId, role: parsed.data.role,
      displayName: parsed.data.displayName, verifiedLegalName: existing?.verifiedLegalName ?? null,
      kycStatus, createdAt: existing?.createdAt ?? at, updatedAt: at });
    const raw = randomProof(); const expiresAt = new Date(at.getTime() + PROOF_TTL_MS);
    await store.insertAccessProof({ id: crypto.randomUUID(), proofHash: await sha256Hex(raw), participantId: parsed.data.participantId,
      purpose: "enrollment", expiresAt, consumedAt: null, createdAt: at });
    return c.json({ participantId: parsed.data.participantId, enrollmentProof: raw, kycStatus,
      displayName: parsed.data.displayName, verifiedLegalName: existing?.verifiedLegalName ?? null, expiresAt: expiresAt.getTime() });
  });

  app.post("/auth/face/enroll", requireInternal(), async (c) => {
    const parsed = EnrollFaceRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !local) return error(c, 400, "invalid-request", "invalid enrollment request");
    const { participantId, image, enrollmentProof, consent } = parsed.data;
    try {
      await validProof(store, enrollmentProof, participantId, "enrollment", now());
      const profile = await store.getIdentityParticipant(participantId);
      if (!profile || (isProduction(c.env) && profile.kycStatus !== "verified")) return error(c, 403, "kyc-required", "verified participant proof required");
      await recordConsent(store, participantId, "enrollment", consent, now());
      const imageBytes = base64ToBytes(image); if (!imageBytes?.length) return error(c, 400, "invalid-request", "invalid image");
      if (isAsyncFaceVerifier(faceVerifier)) {
        if (!parsed.data.identityDocument) return error(c, 400, "invalid-request", "Biometric KYC document required");
        const captures = deps.captureStore ?? (c.env.IDENTITY_CAPTURES ? createR2CaptureStore(c.env.IDENTITY_CAPTURES) : null);
        if (!captures) return error(c, 503, "identity-unavailable", "private enrollment capture storage is not configured");
        // Smile ID owns enrollment liveness + identity match. The private service only prepares
        // a finite embedding and a normalized copy of this same submitted device selfie.
        const prepared = await local.prepareEnrollment(imageBytes);
        const captureSha256 = await sha256CaptureHex(prepared.image);
        const encrypted = await encryptEmbedding(prepared.embedding, encryptionKeyBase64(c.env));
        const jobId = crypto.randomUUID(); const pendingKey = pendingCaptureKey(jobId); const submittedAt = now();
        await captures.putPending(pendingKey, prepared.image, captureSha256);
        let providerJobId: string;
        try { ({ providerJobId } = await faceVerifier.submitEnrollment({ participantId, selfie: prepared.image,
          livenessImages: decodeFrames(parsed.data.livenessImages), userDetails: parsed.data.userDetails,
          identityDocument: parsed.data.identityDocument, consent })); }
        catch {
          await captures.delete(pendingKey).catch(() => undefined);
          return error(c, 502, "identity-unavailable", "KYC provider rejected submission");
        }
        const job = pendingJob(jobId, participantId, profile.role, providerJobId, submittedAt, encrypted, prepared.modelVersion,
          { key: pendingKey, sha256: captureSha256, consent });
        try { await store.insertFaceAuthJob(job); }
        catch (cause) { await captures.delete(pendingKey).catch(() => undefined); throw cause; }
        return c.json({ participantId, kind: "enrollment", status: "pending", jobId: job.id,
          submittedAt: job.createdAt.getTime(), expiresAt: job.expiresAt.getTime() }, 202);
      }
      const analysis = await analyze(local, imageBytes, decodeFrames(parsed.data.livenessImages));
      const at = now(); const encrypted = await encryptEmbedding(analysis.embedding, encryptionKeyBase64(c.env));
      await store.upsertFaceEnrollment({ participantId, role: profile.role,
        embeddingEncrypted: encrypted.ciphertext, iv: encrypted.iv, authTag: encrypted.authTag,
        modelVersion: analysis.modelVersion, providerRef: null, captureObjectKey: null, captureSha256: null,
        captureConsentVersion: null, captureConsentGrantedAt: null, captureRetainedAt: null, createdAt: at, lastVerifiedAt: null });
      const session = await issueSession(store, c.env, participantId, profile.role, at);
      return c.json({ participantId, enrolled: true, modelVersion: analysis.modelVersion, enrolledAt: at.getTime(), session });
    } catch (cause) {
      if (cause instanceof ProofFailure) return error(c, cause.status, cause.code, cause.message);
      return error(c, 502, "identity-unavailable", "biometric analysis unavailable");
    }
  });

  app.post("/auth/face/verify", async (c) => {
    const parsed = VerifyFaceRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !local) return error(c, 400, "invalid-request", "invalid verification request");
    const { participantId, image, consent } = parsed.data; const at = now();
    try {
      await checkAttempts(store, participantId, at); await recordConsent(store, participantId, "authentication", consent, at);
      const enrollment = await store.getFaceEnrollment(participantId);
      if (!enrollment) return error(c, 404, "face-not-enrolled", "no face enrollment");
      if (!enrollment.embeddingEncrypted || !enrollment.iv || !enrollment.authTag) return error(c, 409, "enrollment-provider-mismatch", "local embedding required");
      const imageBytes = base64ToBytes(image); if (!imageBytes?.length) return error(c, 400, "invalid-request", "invalid image");
      const analysis = await analyze(local, imageBytes, decodeFrames(parsed.data.livenessImages));
      const stored = await decryptEmbedding({ ciphertext: enrollment.embeddingEncrypted, iv: enrollment.iv, authTag: enrollment.authTag }, encryptionKeyBase64(c.env));
      const similarity = cosineSimilarity(analysis.embedding, stored); const threshold = faceMatchThreshold(c.env) ?? DEFAULT_FACE_MATCH_THRESHOLD;
      const bucket = similarityBucket(similarity, threshold); const passed = faceMatchPasses(similarity, threshold);
      await audit(store, participantId, passed, bucket, at);
      if (!passed) return error(c, 401, "face-mismatch", "face verification failed", { similarityBucket: bucket });
      const session = await issueSession(store, c.env, participantId, enrollment.role, at); await store.markFaceVerified(participantId, at);
      return c.json({ participantId, verified: true, session });
    } catch (cause) {
      if (cause instanceof ProofFailure) return error(c, cause.status, cause.code, cause.message);
      return error(c, 502, "identity-unavailable", "biometric analysis unavailable");
    }
  });

  app.get("/auth/face/job/:jobId", async (c) => {
    let job = await store.getFaceAuthJob(c.req.param("jobId")); if (!job) return error(c, 404, "job-not-found", "unknown job");
    const captures = deps.captureStore ?? (c.env.IDENTITY_CAPTURES ? createR2CaptureStore(c.env.IDENTITY_CAPTURES) : null);
    if (job.status === "pending" && now() >= job.expiresAt) {
      await failEnrollment(store, captures, job, "expired", now());
      return error(c, 410, "job-expired", "face job expired", { jobId: job.id });
    }
    if (job.status === "pending" && isAsyncFaceVerifier(faceVerifier) && local) {
      try {
        const verdict = await faceVerifier.pollJob(job.providerJobId);
        if (verdict.outcome !== "pending") job = await finalizeEnrollment(store, captures, c.env, job, {
          providerJobId: job.providerJobId, userRef: job.participantId, passed: verdict.outcome === "passed",
          reason: verdict.outcome === "failed" ? verdict.reason : null,
          verifiedLegalName: verdict.outcome === "passed" ? verdict.verifiedLegalName ?? null : null,
        }, now(), reconcile);
      } catch { /* remain pending while the provider is temporarily unavailable */ }
    }
    if (job.status === "pending") return c.json({ jobId: job.id, participantId: job.participantId, kind: job.kind,
      status: "pending", completedAt: null });
    if (job.status === "failed") return error(c, job.failureReason === "expired" ? 410 : 401,
      job.failureReason === "expired" ? "job-expired" : "face-mismatch", "face job failed", { jobId: job.id });
    const profile = await store.getIdentityParticipant(job.participantId);
    const session = await sessionForJob(store, c.env, job, now());
    if (!session) return error(c, 401, "session-invalid", "job session was revoked");
    return c.json({ jobId: job.id, participantId: job.participantId, kind: job.kind, status: "complete",
      completedAt: job.completedAt?.getTime() ?? now().getTime(), suggestedDisplayName: profile?.verifiedLegalName ?? profile?.displayName,
      verifiedLegalName: profile?.verifiedLegalName ?? undefined, session });
  });

  app.post("/callbacks/:provider", async (c) => {
    if (!isAsyncFaceVerifier(faceVerifier) || !local || c.req.param("provider") !== faceVerifier.callbackProvider) return error(c, 404, "job-not-found", "inactive callback");
    let verdict: FaceCallbackVerdict | null;
    try { verdict = await faceVerifier.handleCallback(c.req.raw); } catch { return error(c, 400, "invalid-request", "unparseable callback"); }
    if (!verdict) return error(c, 401, "callback-invalid", "invalid callback signature");
    const job = await store.getFaceAuthJobByProviderId(verdict.providerJobId); if (!job) return c.json({ ok: false, reason: "unknown-job" });
    if (job.status !== "pending") return c.json({ ok: true, jobId: job.id, status: job.status });
    const captures = deps.captureStore ?? (c.env.IDENTITY_CAPTURES ? createR2CaptureStore(c.env.IDENTITY_CAPTURES) : null);
    if (now() >= job.expiresAt) {
      await failEnrollment(store, captures, job, "expired", now());
      return error(c, 410, "job-expired", "face job expired");
    }
    const completed = await finalizeEnrollment(store, captures, c.env, job, verdict, now(), reconcile);
    return c.json({ ok: completed.status === "passed", jobId: completed.id, status: completed.status });
  });

  app.post("/auth/device-key/register", async (c) => {
    const parsed = RegisterDeviceKeyRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return error(c, 400, "invalid-request", "invalid registration request");
    const { participantId, credentialType, secret, publicKey, deviceLabel } = parsed.data; const at = now();
    let proof: IdentityAccessProofRow | null = null;
    const sessionId = await sessionParticipant(store, c.env, c.req.header("authorization"), at);
    try {
      if (sessionId !== participantId) {
        if (!parsed.data.enrollmentProof) return error(c, 401, "unauthorized-proof", "session or enrollment proof required");
        proof = await validProof(store, parsed.data.enrollmentProof, participantId, "enrollment", at);
      }
      let storedPublicKey: string | null = null; let secretHash: string | null = null;
      if (credentialType === "fido") {
        if (!passkeyVerifier) return error(c, 501, "fido-not-implemented", "real FIDO verification unavailable");
        storedPublicKey = (await passkeyVerifier.verifyRegistration(publicKey ?? secret ?? "")).publicKey;
      } else { if (!secret) return error(c, 400, "invalid-request", "secret required"); secretHash = await sha256Hex(secret); }
      if (await store.getLiveCredential(participantId, credentialType) && !fidoUpsertEnabled(c.env)) return error(c, 409, "credential-exists", "credential already exists");
      const row = { id: crypto.randomUUID(), participantId, credentialType, publicKey: storedPublicKey,
        secretHash, deviceLabel: deviceLabel ?? null, createdAt: at, revokedAt: null };
      await store.putDeviceCredential(row); if (proof && !(await store.consumeAccessProof(proof.id, at))) return error(c, 409, "proof-consumed", "proof already consumed");
      return c.json({ credentialId: row.id, participantId, credentialType, createdAt: at.getTime() });
    } catch (cause) { if (cause instanceof ProofFailure) return error(c, cause.status, cause.code, cause.message); throw cause; }
  });

  app.post("/auth/device-key/authenticate", async (c) => {
    const parsed = AuthenticateDeviceKeyRequestSchema.safeParse(await c.req.json().catch(() => null)); if (!parsed.success) return error(c, 400, "invalid-request", "invalid request");
    const { participantId, credentialId, secret } = parsed.data; const credential = await store.getCredentialById(credentialId);
    if (!credential || credential.participantId !== participantId) return error(c, 401, "no-credential", "unknown credential");
    if (credential.revokedAt) return error(c, 401, "credential-revoked", "credential revoked");
    if (credential.credentialType === "fido") {
      if (!passkeyVerifier || !credential.publicKey) return error(c, 501, "fido-not-implemented", "FIDO unavailable");
      if (!await passkeyVerifier.verifyAssertion(credential.publicKey, secret)) return error(c, 401, "no-credential", "assertion rejected");
    } else if (await sha256Hex(secret) !== credential.secretHash) return error(c, 401, "no-credential", "device-key mismatch");
    const enrollment = await store.getFaceEnrollment(participantId); if (!enrollment) return error(c, 401, "no-credential", "participant not enrolled");
    return c.json({ participantId, authenticated: true, session: await issueSession(store, c.env, participantId, enrollment.role, now()) });
  });

  app.post("/auth/recovery", async (c) => {
    const parsed = RecoverDeviceRequestSchema.safeParse(await c.req.json().catch(() => null)); if (!parsed.success || !local) return error(c, 400, "invalid-request", "invalid recovery request");
    const { participantId, image, consent, secret, deviceLabel } = parsed.data; const at = now();
    try {
      await checkAttempts(store, participantId, at); await recordConsent(store, participantId, "recovery", consent, at);
      const enrollment = await store.getFaceEnrollment(participantId);
      if (!enrollment?.embeddingEncrypted || !enrollment.iv || !enrollment.authTag) return error(c, 404, "face-not-enrolled", "recoverable enrollment not found");
      const imageBytes = base64ToBytes(image); if (!imageBytes?.length) return error(c, 400, "invalid-request", "invalid image");
      const analysis = await analyze(local, imageBytes, decodeFrames(parsed.data.livenessImages));
      const stored = await decryptEmbedding({ ciphertext: enrollment.embeddingEncrypted, iv: enrollment.iv, authTag: enrollment.authTag }, encryptionKeyBase64(c.env));
      const similarity = cosineSimilarity(analysis.embedding, stored); const threshold = faceMatchThreshold(c.env) ?? DEFAULT_FACE_MATCH_THRESHOLD;
      const passed = faceMatchPasses(similarity, threshold); await audit(store, participantId, passed, similarityBucket(similarity, threshold), at);
      if (!passed) return error(c, 401, "face-mismatch", "recovery face match failed");
      await store.revokeDeviceCredentials(participantId, at); await store.revokeAuthSessions(participantId, at);
      const credential = { id: crypto.randomUUID(), participantId, credentialType: "device-key" as const,
        publicKey: null, secretHash: await sha256Hex(secret), deviceLabel: deviceLabel ?? null, createdAt: at, revokedAt: null };
      await store.putDeviceCredential(credential);
      return c.json({ participantId, recovered: true, credentialId: credential.id, session: await issueSession(store, c.env, participantId, enrollment.role, at) });
    } catch (cause) { if (cause instanceof ProofFailure) return error(c, cause.status, cause.code, cause.message); return error(c, 502, "identity-unavailable", "recovery unavailable"); }
  });

  app.get("/auth/identity/:participantId", async (c) => {
    const id = await sessionParticipant(store, c.env, c.req.header("authorization"), now());
    if (id !== c.req.param("participantId")) return error(c, 401, "session-invalid", "live session required");
    const profile = await store.getIdentityParticipant(id); if (!profile) return error(c, 404, "invalid-request", "profile not found");
    return c.json({ participantId: id, displayName: profile.displayName, verifiedLegalName: profile.verifiedLegalName, kycStatus: profile.kycStatus });
  });
  app.patch("/auth/identity/:participantId/display-name", async (c) => {
    const id = await sessionParticipant(store, c.env, c.req.header("authorization"), now());
    if (id !== c.req.param("participantId")) return error(c, 401, "session-invalid", "live session required");
    const parsed = DisplayNameRequestSchema.safeParse(await c.req.json().catch(() => null)); if (!parsed.success) return error(c, 400, "invalid-request", "invalid display name");
    await store.updateDisplayName(id, parsed.data.displayName, now()); return c.json({ participantId: id, displayName: parsed.data.displayName });
  });
  app.post("/auth/session/validate", async (c) => {
    const parsed = ValidateSessionRequestSchema.safeParse(await c.req.json().catch(() => null)); if (!parsed.success) return error(c, 400, "invalid-request", "invalid request");
    const result = await verifySessionToken(parsed.data.token, sessionSecret(c.env));
    if (!result.ok) return error(c, 401, result.reason === "expired" ? "session-expired" : "session-invalid", `session ${result.reason}`);
    const row = await store.getAuthSession(result.payload.tokenId);
    if (!row || row.revokedAt) return error(c, 401, "session-invalid", "session revoked or unknown");
    return c.json({ valid: true, payload: result.payload });
  });

  // Manual resets are internal-only. Public replacement uses /auth/recovery with fresh face proof.
  app.post("/auth/device-reset", requireInternal(), async (c) => {
    const parsed = DeviceResetRequestSchema.safeParse(await c.req.json().catch(() => null)); if (!parsed.success) return error(c, 400, "invalid-request", "invalid request");
    const at = now(); const row = { id: crypto.randomUUID(), participantId: parsed.data.participantId, reason: parsed.data.reason,
      status: "pending" as const, createdAt: at, resolvedAt: null, resolvedBy: null };
    await store.insertDeviceResetRequest(row); return c.json({ id: row.id, participantId: row.participantId, status: row.status, createdAt: at.getTime(), resolvedAt: null });
  });
  app.get("/auth/device-reset", requireInternal(), async (c) => {
    const raw = c.req.query("status"); const status = raw === undefined ? undefined : DeviceResetStatusSchema.safeParse(raw);
    if (status && !status.success) return error(c, 400, "invalid-request", "invalid status");
    const rows = await store.listDeviceResetRequests(status?.data);
    return c.json({ requests: rows.map((r) => ({ id: r.id, participantId: r.participantId, reason: r.reason, status: r.status,
      createdAt: r.createdAt.getTime(), resolvedAt: r.resolvedAt?.getTime() ?? null, resolvedBy: r.resolvedBy })) });
  });
  app.post("/auth/device-reset/:id/decision", requireInternal(), async (c) => {
    const parsed = DeviceResetDecisionRequestSchema.safeParse(await c.req.json().catch(() => null)); if (!parsed.success) return error(c, 400, "invalid-request", "invalid decision");
    const request = await store.getDeviceResetRequest(c.req.param("id")); if (!request) return error(c, 404, "reset-not-found", "unknown reset");
    if (request.status !== "pending") return error(c, 409, "reset-already-resolved", "already resolved");
    const at = now(); await store.resolveDeviceResetRequest(request.id, parsed.data.decision, c.env.IDENTITY_INTERNAL_TOKEN ? "ops" : "local-dev-internal", at);
    let revokedCredentials = 0, revokedSessions = 0;
    if (parsed.data.decision === "approved") { revokedCredentials = await store.revokeDeviceCredentials(request.participantId, at);
      if (parsed.data.revokeSessions ?? true) revokedSessions = await store.revokeAuthSessions(request.participantId, at); }
    return c.json({ id: request.id, participantId: request.participantId, status: parsed.data.decision,
      createdAt: request.createdAt.getTime(), resolvedAt: at.getTime(), revokedCredentials, revokedSessions });
  });
  return app;
}
