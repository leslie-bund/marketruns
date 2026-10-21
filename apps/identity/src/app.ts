import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import {
  AuthenticateDeviceKeyRequestSchema,
  DeviceResetDecisionRequestSchema,
  DeviceResetRequestSchema,
  DeviceResetStatusSchema,
  EnrollFaceRequestSchema,
  RegisterDeviceKeyRequestSchema,
  ValidateSessionRequestSchema,
  VerifyFaceRequestSchema,
  type AuthErrorCode,
  type Session,
} from "@market-runs/proto";
import {
  DEFAULT_FACE_MATCH_THRESHOLD,
  SESSION_TOKEN_TTL_MS,
  cosineSimilarity,
  faceMatchPasses,
  signSessionToken,
  similarityBucket,
  verifySessionToken,
} from "@market-runs/domain";
import type { Env } from "./env.js";
import { encryptionKeyBase64, faceMatchThreshold, fidoUpsertEnabled, sessionSecret } from "./env.js";
import { isAsyncFaceVerifier, type AsyncFaceVerifier, type FaceVerifier } from "./face-verifier.js";
import type { PasskeyVerifier } from "./passkey-verifier.js";
import type { FaceAuthJobRow, IdentityStore } from "./store.js";
import { base64ToBytes, decryptEmbedding, encryptEmbedding, sha256Hex } from "./crypto.js";

export interface IdentityDeps {
  store: IdentityStore;
  /** Sync embedding providers (stub) OR async vendor-held providers (ADR-0009 seam). */
  faceVerifier: FaceVerifier | AsyncFaceVerifier;
  /** Null unless FIDO_STUB_ENABLED=true — the fido routes 501 on null (no silent pass). */
  passkeyVerifier: PasskeyVerifier | null;
}

function error(c: Context, status: number, code: AuthErrorCode, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ error: code, message, ...extra }, status as never);
}

/**
 * Internal-seam guard (OPS_TOKEN posture, ADR-0015): when
 * IDENTITY_INTERNAL_TOKEN is set, callers must carry it as
 * `x-identity-internal`; when unset (local dev) the route is OPEN and the
 * resolved operator is labelled "local-dev-internal". DEV-STAGE TRUST: the
 * enrollment route trusts the edge's assertion that the participant exists
 * and passed KYC — the ParticipantDO is edge-side (ADR-0016) and no
 * cross-worker call exists yet; hardening that assertion is an integration
 * step, documented in the report.
 */
function requireInternal(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const token = c.env.IDENTITY_INTERNAL_TOKEN;
    if (token !== undefined && token !== "" && c.req.header("x-identity-internal") !== token) {
      return error(c, 403, "unauthorized-internal", "a valid x-identity-internal token is required");
    }
    await next();
  };
}

async function issueSession(
  store: IdentityStore,
  env: Env,
  participantId: string,
  role: string,
): Promise<Session> {
  const now = Date.now();
  const tokenId = crypto.randomUUID();
  const expiresAt = now + SESSION_TOKEN_TTL_MS;
  const token = await signSessionToken(
    { tokenId, participantId, role, iat: now, exp: expiresAt },
    sessionSecret(env),
  );
  await store.insertAuthSession({
    tokenId,
    participantId,
    issuedAt: new Date(now),
    expiresAt: new Date(expiresAt),
    revokedAt: null,
  });
  return { token, tokenId, expiresAt };
}

/* ------------------------------------------------------------------------ */
/* Async face jobs (vendor-held biometrics, ADR-0009/0022)                   */
/* ------------------------------------------------------------------------ */

function decodeFrames(list: string[] | undefined): Uint8Array[] {
  if (!list) return [];
  const frames: Uint8Array[] = [];
  for (const item of list) {
    const bytes = base64ToBytes(item);
    if (bytes && bytes.length > 0) frames.push(bytes);
  }
  return frames;
}

function newFaceJob(
  kind: FaceAuthJobRow["kind"],
  participantId: string,
  role: string,
  providerJobId: string,
): FaceAuthJobRow {
  return {
    id: crypto.randomUUID(),
    providerJobId,
    participantId,
    role,
    kind,
    status: "pending",
    failureReason: null,
    sessionTokenId: null,
    createdAt: new Date(),
    completedAt: null,
  };
}

/**
 * Transition a pending async job to its verdict — idempotent (provider
 * callbacks are at-least-once; double-completion is a no-op). On a passed
 * enrollment the face_enrollments row is written vendor-held: embedding
 * columns NULL, providerRef = the provider-side user reference. Auth attempts
 * are audited with a NULL similarity bucket (the vendor never returns a
 * score — banded-or-null doctrine holds).
 */
async function finalizeFaceJob(
  store: IdentityStore,
  verifier: AsyncFaceVerifier,
  job: FaceAuthJobRow,
  passed: boolean,
  reason: string | null,
): Promise<FaceAuthJobRow> {
  const transitioned = await store.completeFaceAuthJob(job.id, passed ? "passed" : "failed", reason, new Date());
  if (!transitioned) {
    return (await store.getFaceAuthJob(job.id)) ?? { ...job, status: passed ? "passed" : "failed" };
  }
  const now = new Date();
  if (job.kind === "authentication") {
    await store.insertFaceAuthAttempt({
      id: crypto.randomUUID(),
      participantId: job.participantId,
      outcome: passed ? "pass" : "fail",
      similarityBucket: null,
      createdAt: now,
    });
    if (passed) await store.markFaceVerified(job.participantId, now);
  }
  if (passed && job.kind === "enrollment") {
    await store.upsertFaceEnrollment({
      participantId: job.participantId,
      role: job.role,
      embeddingEncrypted: null,
      iv: null,
      authTag: null,
      modelVersion: verifier.modelVersion,
      providerRef: job.participantId, // provider-side reference == our participantId (keyed at submission)
      createdAt: now,
      lastVerifiedAt: null,
    });
  }
  return (await store.getFaceAuthJob(job.id)) ?? job;
}

/**
 * The session for a passed authentication job, issued LAZILY at collection
 * time (a callback has no client to hand a token to). HMAC tokens are
 * deterministic, so a repeat poll re-derives the exact token from the
 * auth_sessions registry row — the raw token is never stored. Returns null
 * when the issued session was revoked (device reset raced the poll).
 */
async function sessionForJob(store: IdentityStore, env: Env, job: FaceAuthJobRow): Promise<Session | null> {
  if (job.sessionTokenId) {
    const record = await store.getAuthSession(job.sessionTokenId);
    if (!record || record.revokedAt !== null) return null;
    const token = await signSessionToken(
      {
        tokenId: record.tokenId,
        participantId: record.participantId,
        role: job.role,
        iat: record.issuedAt.getTime(),
        exp: record.expiresAt.getTime(),
      },
      sessionSecret(env),
    );
    return { token, tokenId: record.tokenId, expiresAt: record.expiresAt.getTime() };
  }
  const session = await issueSession(store, env, job.participantId, job.role);
  await store.setFaceAuthJobSession(job.id, session.tokenId);
  return session;
}

export function createIdentityApp(deps: IdentityDeps): Hono<{ Bindings: Env }> {
  const { store, faceVerifier, passkeyVerifier } = deps;
  const app = new Hono<{ Bindings: Env }>();

  app.get("/healthz", (c) => c.json({ ok: true, service: "market-runs-identity" }));

  /* ------------------------------------------------------------------ */
  /* Face enrollment (internal: the edge calls this after KYC passes)    */
  /* ------------------------------------------------------------------ */
  app.post("/auth/face/enroll", requireInternal(), async (c) => {
    const parsed = EnrollFaceRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return error(c, 400, "invalid-request", "invalid enrollment request", { issues: parsed.error.issues });
    const { participantId, role, image } = parsed.data;
    const imageBytes = base64ToBytes(image);
    if (!imageBytes || imageBytes.length === 0) {
      return error(c, 400, "invalid-request", "image must be base64-encoded bytes");
    }

    /* Async vendor-held path (ADR-0022 amendment): submit the enrollment job
       and answer 202 honestly — the row lands when the verdict arrives via
       /callbacks/:provider or the job-status poll below. */
    if (isAsyncFaceVerifier(faceVerifier)) {
      const existing = await store.getFaceEnrollment(participantId);
      let providerJobId: string;
      try {
        ({ providerJobId } = await faceVerifier.submitEnrollment({
          participantId,
          selfie: imageBytes,
          livenessImages: decodeFrames(parsed.data.livenessImages),
          userDetails: parsed.data.userDetails,
          // Re-enrollment (e.g. after an approved device reset) replaces the
          // provider-side reference instead of failing.
          allowNewEnroll: existing !== null,
        }));
      } catch {
        return error(c, 502, "identity-unavailable", "the face provider rejected the enrollment submission");
      }
      const job = newFaceJob("enrollment", participantId, role, providerJobId);
      await store.insertFaceAuthJob(job);
      return c.json(
        { participantId, kind: job.kind, status: "pending" as const, jobId: job.id, submittedAt: job.createdAt.getTime() },
        202,
      );
    }

    const embedding = await faceVerifier.embed(imageBytes);
    const encrypted = await encryptEmbedding(embedding, encryptionKeyBase64(c.env));
    const now = new Date();
    await store.upsertFaceEnrollment({
      participantId,
      role,
      embeddingEncrypted: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      modelVersion: faceVerifier.modelVersion,
      providerRef: null, // self-held embedding mode
      createdAt: now,
      lastVerifiedAt: null,
    });
    return c.json({ participantId, enrolled: true as const, modelVersion: faceVerifier.modelVersion, enrolledAt: now.getTime() });
  });

  /* ------------------------------------------------------------------ */
  /* Face verification → session (passwordless login)                    */
  /* ------------------------------------------------------------------ */
  app.post("/auth/face/verify", async (c) => {
    const parsed = VerifyFaceRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return error(c, 400, "invalid-request", "invalid verification request", { issues: parsed.error.issues });
    const { participantId, image } = parsed.data;
    const enrollment = await store.getFaceEnrollment(participantId);
    if (!enrollment) {
      return error(c, 404, "face-not-enrolled", "no face enrollment for this participant");
    }
    const imageBytes = base64ToBytes(image);
    if (!imageBytes || imageBytes.length === 0) {
      return error(c, 400, "invalid-request", "image must be base64-encoded bytes");
    }

    /* Async vendor-held path: delegate to the provider's authentication job
       against the enrolled reference; the session is issued when the client
       collects a passing verdict from GET /auth/face/job/:jobId. */
    if (isAsyncFaceVerifier(faceVerifier)) {
      if (enrollment.providerRef === null) {
        return error(
          c,
          409,
          "enrollment-provider-mismatch",
          "this enrollment is self-held (local embedding) but the active provider is vendor-held; re-enroll or switch FACE_VERIFIER",
        );
      }
      let providerJobId: string;
      try {
        ({ providerJobId } = await faceVerifier.submitAuthentication({
          participantId,
          selfie: imageBytes,
          livenessImages: decodeFrames(parsed.data.livenessImages),
          userDetails: parsed.data.userDetails,
        }));
      } catch {
        return error(c, 502, "identity-unavailable", "the face provider rejected the verification submission");
      }
      const job = newFaceJob("authentication", participantId, enrollment.role, providerJobId);
      await store.insertFaceAuthJob(job);
      return c.json(
        { participantId, kind: job.kind, status: "pending" as const, jobId: job.id, submittedAt: job.createdAt.getTime() },
        202,
      );
    }

    /* Self-held path: decrypt the one row and compare in memory. A NULL
       embedding under a sync provider means the row is vendor-held — the
       active provider mode and the row's mode disagree. */
    if (!enrollment.embeddingEncrypted || !enrollment.iv || !enrollment.authTag) {
      return error(
        c,
        409,
        "enrollment-provider-mismatch",
        "this enrollment is vendor-held but the active provider is self-held; re-enroll or switch FACE_VERIFIER",
      );
    }
    const embedding = await faceVerifier.embed(imageBytes);
    const stored = await decryptEmbedding(
      { ciphertext: enrollment.embeddingEncrypted, iv: enrollment.iv, authTag: enrollment.authTag },
      encryptionKeyBase64(c.env),
    );
    const similarity = cosineSimilarity(embedding, stored);
    const threshold = faceMatchThreshold(c.env) ?? DEFAULT_FACE_MATCH_THRESHOLD;
    const bucket = similarityBucket(similarity, threshold);
    if (!faceMatchPasses(similarity, threshold)) {
      await store.insertFaceAuthAttempt({
        id: crypto.randomUUID(),
        participantId,
        outcome: "fail",
        similarityBucket: bucket,
        createdAt: new Date(),
      });
      // The band is returned for UX ("try again, better light"); the raw
      // score is NEVER on the wire — a live score oracle lets an attacker
      // hill-climb toward the threshold.
      return error(c, 401, "face-mismatch", "face verification failed", { similarityBucket: bucket });
    }
    const session = await issueSession(store, c.env, participantId, enrollment.role);
    const now = new Date();
    await store.markFaceVerified(participantId, now);
    await store.insertFaceAuthAttempt({
      id: crypto.randomUUID(),
      participantId,
      outcome: "pass",
      similarityBucket: bucket,
      createdAt: now,
    });
    return c.json({ participantId, verified: true as const, session });
  });

  /* ------------------------------------------------------------------ */
  /* Async face jobs: status polling + provider callbacks (ADR-0009)      */
  /* ------------------------------------------------------------------ */

  /**
   * Client poll for an async enroll/verify job. While pending and an async
   * provider is active, we poll the provider eagerly so local/sandbox dev
   * works without a public callback URL; the callback route is the production
   * path. Failed jobs answer 401 face-mismatch (same honesty as the sync
   * path: the vendor's reason string is server-side, the client gets the
   * code). Passed authentication jobs issue the session here, at collection.
   */
  app.get("/auth/face/job/:jobId", async (c) => {
    let job = await store.getFaceAuthJob(c.req.param("jobId"));
    if (!job) return error(c, 404, "job-not-found", "unknown face job");
    if (job.status === "pending" && isAsyncFaceVerifier(faceVerifier)) {
      try {
        const verdict = await faceVerifier.pollJob(job.providerJobId);
        if (verdict.outcome !== "pending") {
          job = await finalizeFaceJob(
            store,
            faceVerifier,
            job,
            verdict.outcome === "passed",
            verdict.outcome === "failed" ? verdict.reason : null,
          );
        }
      } catch {
        // Provider unreachable — stay pending honestly; the client re-polls.
      }
    }
    if (job.status === "pending") {
      return c.json({ jobId: job.id, participantId: job.participantId, kind: job.kind, status: "pending" as const, completedAt: null });
    }
    if (job.status === "failed") {
      return error(c, 401, "face-mismatch", "face job failed", { jobId: job.id });
    }
    const complete = {
      jobId: job.id,
      participantId: job.participantId,
      kind: job.kind,
      status: "complete" as const,
      completedAt: job.completedAt?.getTime() ?? null,
    };
    if (job.kind === "enrollment") return c.json(complete);
    const session = await sessionForJob(store, c.env, job);
    if (!session) return error(c, 401, "session-invalid", "the session issued for this job was revoked");
    return c.json({ ...complete, session });
  });

  /**
   * Provider result callbacks. The :provider segment must match the ACTIVE
   * verifier's declared provider, and the verifier authenticates the request
   * by signature — no internal token here, the signature IS the auth.
   * Unknown-but-authentic jobs are acked 200 so the provider stops retrying
   * (delivery is at-least-once, retried 3×; a job we never recorded is not
   * ours to complete).
   */
  app.post("/callbacks/:provider", async (c) => {
    if (!isAsyncFaceVerifier(faceVerifier) || c.req.param("provider") !== faceVerifier.callbackProvider) {
      return error(c, 404, "job-not-found", "no active face provider answers this callback path");
    }
    let verdict;
    try {
      verdict = await faceVerifier.handleCallback(c.req.raw);
    } catch {
      return error(c, 400, "invalid-request", "well-signed callback with an unparseable payload");
    }
    if (!verdict) return error(c, 401, "callback-invalid", "callback signature did not verify");
    const job = await store.getFaceAuthJobByProviderId(verdict.providerJobId);
    if (!job) return c.json({ ok: false as const, reason: "unknown-job" as const });
    const completed = await finalizeFaceJob(store, faceVerifier, job, verdict.passed, verdict.reason);
    return c.json({ ok: true as const, jobId: completed.id, status: completed.status });
  });

  /* ------------------------------------------------------------------ */
  /* Device credentials (keychain seam + dev-gated FIDO stub)            */
  /* ------------------------------------------------------------------ */
  app.post("/auth/device-key/register", async (c) => {
    const parsed = RegisterDeviceKeyRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return error(c, 400, "invalid-request", "invalid registration request", { issues: parsed.error.issues });
    const { participantId, credentialType, secret, publicKey, deviceLabel } = parsed.data;

    let storedPublicKey: string | null = null;
    let secretHash: string | null = null;
    if (credentialType === "fido") {
      if (!passkeyVerifier) {
        return error(c, 501, "fido-not-implemented", "FIDO verification is TODO-real-vendor; the dev stub requires FIDO_STUB_ENABLED=true");
      }
      const attestation = publicKey ?? secret;
      if (!attestation) return error(c, 400, "invalid-request", "fido registration requires publicKey");
      storedPublicKey = (await passkeyVerifier.verifyRegistration(attestation)).publicKey;
    } else {
      if (!secret) return error(c, 400, "invalid-request", "device-key registration requires secret");
      secretHash = await sha256Hex(secret); // the raw secret is never stored
    }

    const existing = await store.getLiveCredential(participantId, credentialType);
    if (existing && !fidoUpsertEnabled(c.env)) {
      return error(c, 409, "credential-exists", "a credential of this type already exists; request a device reset, or set FIDO_UPSERT_ENABLED=true for multi-device testing");
    }
    const now = new Date();
    const row = {
      id: crypto.randomUUID(),
      participantId,
      credentialType,
      publicKey: storedPublicKey,
      secretHash,
      deviceLabel: deviceLabel ?? null,
      createdAt: now,
      revokedAt: null,
    };
    // Upsert semantics: replaces any existing (revoked, or — under
    // FIDO_UPSERT_ENABLED — live) row for (participant, type).
    await store.putDeviceCredential(row);
    return c.json({ credentialId: row.id, participantId, credentialType, createdAt: now.getTime() });
  });

  app.post("/auth/device-key/authenticate", async (c) => {
    const parsed = AuthenticateDeviceKeyRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return error(c, 400, "invalid-request", "invalid authentication request", { issues: parsed.error.issues });
    const { participantId, credentialId, secret } = parsed.data;
    const credential = await store.getCredentialById(credentialId);
    if (!credential || credential.participantId !== participantId) {
      return error(c, 401, "no-credential", "unknown credential");
    }
    if (credential.revokedAt !== null) {
      return error(c, 401, "credential-revoked", "credential was revoked (device reset); re-enroll");
    }
    if (credential.credentialType === "fido") {
      if (!passkeyVerifier || !credential.publicKey) {
        return error(c, 501, "fido-not-implemented", "FIDO verification is TODO-real-vendor; the dev stub requires FIDO_STUB_ENABLED=true");
      }
      const ok = await passkeyVerifier.verifyAssertion(credential.publicKey, secret);
      if (!ok) return error(c, 401, "no-credential", "assertion rejected");
    } else {
      if ((await sha256Hex(secret)) !== credential.secretHash) {
        return error(c, 401, "no-credential", "device-key mismatch");
      }
    }
    // Role authority is the ParticipantDO (edge-side, ADR-0016); the identity
    // worker reuses the enrollment-recorded role, falling back to buyer with
    // this dev-stage caveat — the integration step should pass the edge's
    // asserted role through the proxy.
    const enrollment = await store.getFaceEnrollment(participantId);
    const session = await issueSession(store, c.env, participantId, enrollment?.role ?? "buyer");
    return c.json({ participantId, authenticated: true as const, session });
  });

  /* ------------------------------------------------------------------ */
  /* Session validation (authoritative; the edge usually verifies HMAC   */
  /* locally and only calls this when revocation matters)                */
  /* ------------------------------------------------------------------ */
  app.post("/auth/session/validate", async (c) => {
    const parsed = ValidateSessionRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return error(c, 400, "invalid-request", "invalid validation request", { issues: parsed.error.issues });
    const result = await verifySessionToken(parsed.data.token, sessionSecret(c.env));
    if (!result.ok) {
      return error(c, 401, result.reason === "expired" ? "session-expired" : "session-invalid", `session token ${result.reason}`);
    }
    const record = await store.getAuthSession(result.payload.tokenId);
    if (!record || record.revokedAt !== null) {
      return error(c, 401, "session-invalid", "session was revoked or never issued");
    }
    return c.json({ valid: true as const, payload: result.payload });
  });

  /* ------------------------------------------------------------------ */
  /* Device reset — the dispute-like flow                                */
  /* ------------------------------------------------------------------ */
  app.post("/auth/device-reset", async (c) => {
    // Public by design: a participant who lost their device cannot present
    // that device's session. The ops decision below is the gate.
    const parsed = DeviceResetRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return error(c, 400, "invalid-request", "invalid device-reset request", { issues: parsed.error.issues });
    const now = new Date();
    const row = {
      id: crypto.randomUUID(),
      participantId: parsed.data.participantId,
      reason: parsed.data.reason,
      status: "pending" as const,
      createdAt: now,
      resolvedAt: null,
      resolvedBy: null,
    };
    await store.insertDeviceResetRequest(row);
    return c.json({ id: row.id, participantId: row.participantId, status: row.status, createdAt: now.getTime(), resolvedAt: null });
  });

  /**
   * The reset queue for the ops console (ADR-0022's ops-approved reset):
   * internal like the decision route — a participant's reset history is not
   * public. `?status=` filters; absent returns every request, oldest first.
   */
  app.get("/auth/device-reset", requireInternal(), async (c) => {
    const raw = c.req.query("status");
    const status = raw === undefined ? undefined : DeviceResetStatusSchema.safeParse(raw);
    if (status !== undefined && !status.success) {
      return error(c, 400, "invalid-request", "status must be pending, approved, or rejected", { issues: status.error.issues });
    }
    const rows = await store.listDeviceResetRequests(status?.data);
    return c.json({
      requests: rows.map((row) => ({
        id: row.id,
        participantId: row.participantId,
        reason: row.reason,
        status: row.status,
        createdAt: row.createdAt.getTime(),
        resolvedAt: row.resolvedAt?.getTime() ?? null,
        resolvedBy: row.resolvedBy,
      })),
    });
  });

  app.post("/auth/device-reset/:id/decision", requireInternal(), async (c) => {
    const parsed = DeviceResetDecisionRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return error(c, 400, "invalid-request", "invalid decision request", { issues: parsed.error.issues });
    const request = await store.getDeviceResetRequest(c.req.param("id"));
    if (!request) return error(c, 404, "reset-not-found", "unknown device-reset request");
    if (request.status !== "pending") {
      return error(c, 409, "reset-already-resolved", `request already ${request.status}`);
    }
    const now = new Date();
    const resolvedBy = c.env.IDENTITY_INTERNAL_TOKEN ? "ops" : "local-dev-internal";
    await store.resolveDeviceResetRequest(request.id, parsed.data.decision, resolvedBy, now);
    let revokedCredentials = 0;
    let revokedSessions = 0;
    if (parsed.data.decision === "approved") {
      revokedCredentials = await store.revokeDeviceCredentials(request.participantId, now);
      if (parsed.data.revokeSessions ?? true) {
        revokedSessions = await store.revokeAuthSessions(request.participantId, now);
      }
    }
    return c.json({
      id: request.id,
      participantId: request.participantId,
      status: parsed.data.decision,
      createdAt: request.createdAt.getTime(),
      resolvedAt: now.getTime(),
      revokedCredentials,
      revokedSessions,
    });
  });

  return app;
}
