import type {
  AuthSessionRow, BiometricConsentRow, DeviceCredentialRow, DeviceResetRequestRow, FaceAuthAttemptRow,
  FaceAuthJobRow, FaceEnrollmentRow, IdentityAccessProofRow, IdentityParticipantRow, IdentityStore,
} from "./store.js";

export function createMemoryStore(): IdentityStore & {
  participants: Map<string, IdentityParticipantRow>; proofs: Map<string, IdentityAccessProofRow>;
  consents: BiometricConsentRow[]; enrollments: Map<string, FaceEnrollmentRow>; credentials: DeviceCredentialRow[];
  sessions: Map<string, AuthSessionRow>; resets: Map<string, DeviceResetRequestRow>;
  attempts: FaceAuthAttemptRow[]; jobs: Map<string, FaceAuthJobRow>;
} {
  const participants = new Map<string, IdentityParticipantRow>();
  const proofs = new Map<string, IdentityAccessProofRow>();
  const consents: BiometricConsentRow[] = [];
  const enrollments = new Map<string, FaceEnrollmentRow>();
  const credentials: DeviceCredentialRow[] = [];
  const sessions = new Map<string, AuthSessionRow>();
  const resets = new Map<string, DeviceResetRequestRow>();
  const attempts: FaceAuthAttemptRow[] = [];
  const jobs = new Map<string, FaceAuthJobRow>();
  return {
    participants, proofs, consents, enrollments, credentials, sessions, resets, attempts, jobs,
    async getIdentityParticipant(id) { return participants.get(id) ?? null; },
    async putIdentityParticipant(row) { participants.set(row.participantId, { ...row }); },
    async completeIdentityKyc(id, legalName, at) {
      const row = participants.get(id);
      if (row) Object.assign(row, { kycStatus: "verified", verifiedLegalName: row.verifiedLegalName ?? legalName, updatedAt: at });
    },
    async updateDisplayName(id, displayName, at) {
      const row = participants.get(id); if (row) Object.assign(row, { displayName, updatedAt: at });
    },
    async insertAccessProof(row) { proofs.set(row.proofHash, { ...row }); },
    async getAccessProof(hash) { return proofs.get(hash) ?? null; },
    async consumeAccessProof(id, at) {
      const row = [...proofs.values()].find((p) => p.id === id);
      if (!row || row.consumedAt) return false; row.consumedAt = at; return true;
    },
    async insertBiometricConsent(row) { consents.push({ ...row }); },
    async getFaceEnrollment(id) { return enrollments.get(id) ?? null; },
    async upsertFaceEnrollment(row) { enrollments.set(row.participantId, { ...row }); },
    async markFaceVerified(id, at) { const row = enrollments.get(id); if (row) row.lastVerifiedAt = at; },
    async getLiveCredential(id, type) {
      return credentials.find((r) => r.participantId === id && r.credentialType === type && r.revokedAt === null) ?? null;
    },
    async getCredentialById(id) { return credentials.find((r) => r.id === id) ?? null; },
    async putDeviceCredential(row) {
      const i = credentials.findIndex((r) => r.participantId === row.participantId && r.credentialType === row.credentialType);
      if (i < 0) credentials.push({ ...row }); else credentials[i] = { ...row };
    },
    async revokeDeviceCredentials(id, at) {
      let n = 0; for (const row of credentials) if (row.participantId === id && !row.revokedAt) { row.revokedAt = at; n++; } return n;
    },
    async insertAuthSession(row) { sessions.set(row.tokenId, { ...row }); },
    async getAuthSession(id) { return sessions.get(id) ?? null; },
    async revokeAuthSessions(id, at) {
      let n = 0; for (const row of sessions.values()) if (row.participantId === id && !row.revokedAt) { row.revokedAt = at; n++; } return n;
    },
    async insertDeviceResetRequest(row) { resets.set(row.id, { ...row }); },
    async getDeviceResetRequest(id) { return resets.get(id) ?? null; },
    async listDeviceResetRequests(status) {
      return [...resets.values()].filter((r) => !status || r.status === status).sort((a, b) => +a.createdAt - +b.createdAt);
    },
    async resolveDeviceResetRequest(id, status, by, at) {
      const row = resets.get(id); if (row) Object.assign(row, { status, resolvedBy: by, resolvedAt: at });
    },
    async insertFaceAuthAttempt(row) { attempts.push({ ...row }); },
    async countRecentFaceFailures(id, since) {
      return attempts.filter((r) => r.participantId === id && r.outcome === "fail" && r.createdAt > since).length;
    },
    async insertFaceAuthJob(row) { jobs.set(row.id, { ...row }); },
    async getFaceAuthJob(id) { return jobs.get(id) ?? null; },
    async getFaceAuthJobByProviderId(id) { return [...jobs.values()].find((j) => j.providerJobId === id) ?? null; },
    async listExpiredPendingFaceAuthJobs(now) {
      return [...jobs.values()].filter((job) => job.status === "pending" && job.expiresAt < now).sort((a, b) => +a.expiresAt - +b.expiresAt);
    },
    async completeFaceAuthJob(id, status, reason, at) {
      const row = jobs.get(id); if (!row || row.status !== "pending") return false;
      Object.assign(row, { status, failureReason: reason, completedAt: at,
        pendingEmbeddingEncrypted: null, pendingEmbeddingIv: null, pendingEmbeddingAuthTag: null,
        pendingModelVersion: null, pendingCaptureObjectKey: null, pendingCaptureSha256: null,
        pendingCaptureConsentVersion: null, pendingCaptureConsentGrantedAt: null }); return true;
    },
    async setFaceAuthJobSession(id, tokenId) { const row = jobs.get(id); if (row) row.sessionTokenId = tokenId; },
  };
}
