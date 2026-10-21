import type {
  AuthSessionRow,
  DeviceCredentialRow,
  DeviceResetRequestRow,
  FaceAuthAttemptRow,
  FaceAuthJobRow,
  FaceEnrollmentRow,
  IdentityStore,
} from "./store.js";

/**
 * In-memory IdentityStore — TESTS ONLY. Mirrors the Drizzle implementation's
 * semantics (one live credential per participant+type, upsert-replace,
 * atomic reset resolution) so route tests exercise the real handlers without
 * a database. Production always wires createDrizzleStore (ADR-0011).
 */
export function createMemoryStore(): IdentityStore & {
  enrollments: Map<string, FaceEnrollmentRow>;
  credentials: DeviceCredentialRow[];
  sessions: Map<string, AuthSessionRow>;
  resets: Map<string, DeviceResetRequestRow>;
  attempts: FaceAuthAttemptRow[];
  jobs: Map<string, FaceAuthJobRow>;
} {
  const enrollments = new Map<string, FaceEnrollmentRow>();
  const credentials: DeviceCredentialRow[] = [];
  const sessions = new Map<string, AuthSessionRow>();
  const resets = new Map<string, DeviceResetRequestRow>();
  const attempts: FaceAuthAttemptRow[] = [];
  const jobs = new Map<string, FaceAuthJobRow>();

  return {
    enrollments,
    credentials,
    sessions,
    resets,
    attempts,
    jobs,

    async getFaceEnrollment(participantId) {
      return enrollments.get(participantId) ?? null;
    },
    async upsertFaceEnrollment(row) {
      enrollments.set(row.participantId, { ...row });
    },
    async markFaceVerified(participantId, at) {
      const row = enrollments.get(participantId);
      if (row) row.lastVerifiedAt = at;
    },

    async getLiveCredential(participantId, credentialType) {
      return (
        credentials.find(
          (row) => row.participantId === participantId && row.credentialType === credentialType && row.revokedAt === null,
        ) ?? null
      );
    },
    async getCredentialById(id) {
      return credentials.find((row) => row.id === id) ?? null;
    },
    async putDeviceCredential(row) {
      const index = credentials.findIndex(
        (existing) => existing.participantId === row.participantId && existing.credentialType === row.credentialType,
      );
      if (index === -1) credentials.push({ ...row });
      else credentials[index] = { ...row };
    },
    async revokeDeviceCredentials(participantId, at) {
      let count = 0;
      for (const row of credentials) {
        if (row.participantId === participantId && row.revokedAt === null) {
          row.revokedAt = at;
          count += 1;
        }
      }
      return count;
    },

    async insertAuthSession(row) {
      sessions.set(row.tokenId, { ...row });
    },
    async getAuthSession(tokenId) {
      return sessions.get(tokenId) ?? null;
    },
    async revokeAuthSessions(participantId, at) {
      let count = 0;
      for (const row of sessions.values()) {
        if (row.participantId === participantId && row.revokedAt === null) {
          row.revokedAt = at;
          count += 1;
        }
      }
      return count;
    },

    async insertDeviceResetRequest(row) {
      resets.set(row.id, { ...row });
    },
    async getDeviceResetRequest(id) {
      return resets.get(id) ?? null;
    },
    async listDeviceResetRequests(status) {
      return [...resets.values()]
        .filter((row) => status === undefined || row.status === status)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((row) => ({ ...row }));
    },
    async resolveDeviceResetRequest(id, status, resolvedBy, at) {
      const row = resets.get(id);
      if (row) {
        row.status = status;
        row.resolvedBy = resolvedBy;
        row.resolvedAt = at;
      }
    },

    async insertFaceAuthAttempt(row) {
      attempts.push({ ...row });
    },

    async insertFaceAuthJob(row) {
      jobs.set(row.id, { ...row });
    },
    async getFaceAuthJob(id) {
      return jobs.get(id) ?? null;
    },
    async getFaceAuthJobByProviderId(providerJobId) {
      for (const row of jobs.values()) {
        if (row.providerJobId === providerJobId) return row;
      }
      return null;
    },
    async completeFaceAuthJob(id, status, failureReason, at) {
      const row = jobs.get(id);
      if (!row || row.status !== "pending") return false; // at-least-once callbacks: double-complete is a no-op
      row.status = status;
      row.failureReason = failureReason;
      row.completedAt = at;
      return true;
    },
    async setFaceAuthJobSession(id, sessionTokenId) {
      const row = jobs.get(id);
      if (row) row.sessionTokenId = sessionTokenId;
    },
  };
}
