import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import {
  AuthenticateDeviceKeyRequestSchema, BIOMETRIC_CONSENT_VERSION, DeviceResetDecisionRequestSchema,
  DeviceResetRequestSchema, DeviceResetStatusSchema, DisplayNameRequestSchema, EnrollFaceRequestSchema,
  EnrollmentProofRequestSchema, RecoverDeviceRequestSchema, RegisterDeviceKeyRequestSchema,
  ValidateSessionRequestSchema, VerifyFaceRequestSchema, type AuthErrorCode, type BiometricConsent, type Session,
} from "@market-runs/proto";
import {
  DEFAULT_FACE_MATCH_THRESHOLD, SESSION_TOKEN_TTL_MS, cosineSimilarity, faceMatchPasses,
  signSessionToken, similarityBucket, verifySessionToken,
} from "@market-runs/domain";
import type { Env } from "./env.js";
import { encryptionKeyBase64, faceMatchThreshold, fidoUpsertEnabled, isProduction, sessionSecret } from "./env.js";
import { BiometricServiceError, isAsyncFaceVerifier, type AsyncFaceVerifier, type FaceCallbackVerdict, type FaceVerifier } from "./face-verifier.js";
import type { PasskeyVerifier } from "./passkey-verifier.js";
import type { FaceAuthJobRow, IdentityAccessProofRow, IdentityStore } from "./store.js";
import { base64ToBytes, decryptEmbedding, encryptEmbedding, sha256Hex } from "./crypto.js";

const PROOF_TTL_MS = 15 * 60_000;
const JOB_TTL_MS = 2 * 60_000;
const ATTEMPT_WINDOW_MS = 15 * 60_000;
const MAX_FAILED_ATTEMPTS = 5;
export interface IdentityDeps {
  store: IdentityStore;
  faceVerifier: FaceVerifier | AsyncFaceVerifier;
  localFaceVerifier?: FaceVerifier;
  passkeyVerifier: PasskeyVerifier | null;
  now?: () => Date;
}
function error(c: Context, status: number, code: AuthErrorCode, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ error: code, message, ...extra }, status as never);
}
function requireInternal(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const token = c.env.IDENTITY_INTERNAL_TOKEN;
    if (!token && isProduction(c.env)) return error(c, 503, "identity-unavailable", "IDENTITY_INTERNAL_TOKEN is required in production");
    if (token && c.req.header("x-identity-internal") !== token) return error(c, 403, "unauthorized-internal", "valid internal token required");
    await next();
  };
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
function pendingJob(participantId: string, role: string, providerJobId: string, now: Date,
  pending?: { ciphertext: Uint8Array; iv: Uint8Array; authTag: Uint8Array }, modelVersion?: string): FaceAuthJobRow {
  return { id: crypto.randomUUID(), providerJobId, participantId, role, kind: "enrollment", status: "pending",
    failureReason: null, sessionTokenId: null, pendingEmbeddingEncrypted: pending?.ciphertext ?? null,
    pendingEmbeddingIv: pending?.iv ?? null, pendingEmbeddingAuthTag: pending?.authTag ?? null,
    pendingModelVersion: modelVersion ?? null, createdAt: now, expiresAt: new Date(now.getTime() + JOB_TTL_MS), completedAt: null };
}
async function finalizeEnrollment(store: IdentityStore, local: FaceVerifier, env: Env, job: FaceAuthJobRow,
  verdict: FaceCallbackVerdict, now: Date): Promise<FaceAuthJobRow> {
  if (now >= job.expiresAt || job.status !== "pending") {
    await store.completeFaceAuthJob(job.id, "failed", "expired", now); return (await store.getFaceAuthJob(job.id)) ?? job;
  }
  if (!verdict.passed || verdict.userRef !== job.participantId) {
    await store.completeFaceAuthJob(job.id, "failed", verdict.userRef !== job.participantId ? "participant-mismatch" : verdict.reason, now);
    return (await store.getFaceAuthJob(job.id)) ?? job;
  }
  let encrypted = job.pendingEmbeddingEncrypted && job.pendingEmbeddingIv && job.pendingEmbeddingAuthTag ? {
    ciphertext: job.pendingEmbeddingEncrypted, iv: job.pendingEmbeddingIv, authTag: job.pendingEmbeddingAuthTag,
  } : null;
  let modelVersion = job.pendingModelVersion;
  // A provider callback image is an authorized temporary selfie fallback. It is never persisted.
  if (!encrypted && verdict.providerImage) {
    const embedding = await local.embed(verdict.providerImage);
    encrypted = await encryptEmbedding(embedding, encryptionKeyBase64(env)); modelVersion = local.modelVersion;
  }
  if (!encrypted || !modelVersion) {
    await store.completeFaceAuthJob(job.id, "failed", "missing-pending-embedding", now);
    return (await store.getFaceAuthJob(job.id)) ?? job;
  }
  await store.completeIdentityKyc(job.participantId, verdict.verifiedLegalName ?? null, now);
  await store.upsertFaceEnrollment({ participantId: job.participantId, role: job.role, embeddingEncrypted: encrypted.ciphertext,
    iv: encrypted.iv, authTag: encrypted.authTag, modelVersion, providerRef: job.participantId, createdAt: now, lastVerifiedAt: null });
  await store.completeFaceAuthJob(job.id, "passed", null, now);
  return (await store.getFaceAuthJob(job.id)) ?? { ...job, status: "passed", completedAt: now };
}

export function createIdentityApp(deps: IdentityDeps): Hono<{ Bindings: Env }> {
  const { store, faceVerifier, passkeyVerifier } = deps;
  const local = deps.localFaceVerifier ?? (isAsyncFaceVerifier(faceVerifier) ? null : faceVerifier);
  const now = () => deps.now?.() ?? new Date();
  const app = new Hono<{ Bindings: Env }>();
  app.get("/healthz", (c) => c.json({ ok: true, service: "market-runs-identity" }));

  app.post("/auth/enrollment-proof", requireInternal(), async (c) => {
    const parsed = EnrollmentProofRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return error(c, 400, "invalid-request", "invalid proof request");
    if (isProduction(c.env) && parsed.data.kycStatus !== "verified") return error(c, 403, "kyc-required", "production enrollment requires verified KYC");
    const at = now(); const existing = await store.getIdentityParticipant(parsed.data.participantId);
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

  app.post("/auth/face/enroll", async (c) => {
    const parsed = EnrollFaceRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !local) return error(c, 400, "invalid-request", "invalid enrollment request");
    const { participantId, image, enrollmentProof, consent } = parsed.data;
    try {
      await validProof(store, enrollmentProof, participantId, "enrollment", now());
      const profile = await store.getIdentityParticipant(participantId);
      if (!profile || (isProduction(c.env) && profile.kycStatus !== "verified")) return error(c, 403, "kyc-required", "verified participant proof required");
      await recordConsent(store, participantId, "enrollment", consent, now());
      const imageBytes = base64ToBytes(image); if (!imageBytes?.length) return error(c, 400, "invalid-request", "invalid image");
      const analysis = await analyze(local, imageBytes, decodeFrames(parsed.data.livenessImages));
      if (isAsyncFaceVerifier(faceVerifier)) {
        if (!parsed.data.identityDocument) return error(c, 400, "invalid-request", "Biometric KYC document required");
        const encrypted = await encryptEmbedding(analysis.embedding, encryptionKeyBase64(c.env));
        let providerJobId: string;
        try { ({ providerJobId } = await faceVerifier.submitEnrollment({ participantId, selfie: imageBytes,
          livenessImages: decodeFrames(parsed.data.livenessImages), userDetails: parsed.data.userDetails,
          identityDocument: parsed.data.identityDocument, consent })); }
        catch { return error(c, 502, "identity-unavailable", "KYC provider rejected submission"); }
        const job = pendingJob(participantId, profile.role, providerJobId, now(), encrypted, analysis.modelVersion);
        await store.insertFaceAuthJob(job);
        return c.json({ participantId, kind: "enrollment", status: "pending", jobId: job.id,
          submittedAt: job.createdAt.getTime(), expiresAt: job.expiresAt.getTime() }, 202);
      }
      const at = now(); const encrypted = await encryptEmbedding(analysis.embedding, encryptionKeyBase64(c.env));
      await store.upsertFaceEnrollment({ participantId, role: profile.role,
        embeddingEncrypted: encrypted.ciphertext, iv: encrypted.iv, authTag: encrypted.authTag,
        modelVersion: analysis.modelVersion, providerRef: null, createdAt: at, lastVerifiedAt: null });
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
    if (job.status === "pending" && now() >= job.expiresAt) {
      await store.completeFaceAuthJob(job.id, "failed", "expired", now());
      return error(c, 410, "job-expired", "face job expired", { jobId: job.id });
    }
    if (job.status === "pending" && isAsyncFaceVerifier(faceVerifier) && local) {
      try {
        const verdict = await faceVerifier.pollJob(job.providerJobId);
        if (verdict.outcome !== "pending") job = await finalizeEnrollment(store, local, c.env, job, {
          providerJobId: job.providerJobId, userRef: job.participantId, passed: verdict.outcome === "passed",
          reason: verdict.outcome === "failed" ? verdict.reason : null,
          verifiedLegalName: verdict.outcome === "passed" ? verdict.verifiedLegalName ?? null : null,
          providerImage: verdict.outcome === "passed" ? verdict.providerImage ?? null : null,
        }, now());
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
    if (now() >= job.expiresAt) return error(c, 410, "job-expired", "face job expired");
    const completed = await finalizeEnrollment(store, local, c.env, job, verdict, now());
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
