import { and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  authSessions,
  deviceCredentials,
  deviceResetRequests,
  faceAuthAttempts,
  faceAuthJobs,
  faceEnrollments,
} from "../../../infra/drizzle/schema.js";
import type * as schema from "../../../infra/drizzle/schema.js";

/**
 * Persistence seam for the identity worker. The route handlers depend only
 * on this interface: production wires the Drizzle implementation (Postgres,
 * ADR-0011 — the edge never touches these tables); tests wire the in-memory
 * implementation (dev-store.ts), so the full enroll → verify → reset
 * lifecycle is exercisable without a database.
 */

export interface FaceEnrollmentRow {
  participantId: string;
  role: string;
  /** NULL when the biometric reference is vendor-held (providerRef set). */
  embeddingEncrypted: Uint8Array | null;
  iv: Uint8Array | null;
  authTag: Uint8Array | null;
  modelVersion: string;
  /** Provider-side enrollment reference; NULL for self-held embeddings. */
  providerRef: string | null;
  createdAt: Date;
  lastVerifiedAt: Date | null;
}

export interface FaceAuthJobRow {
  /** Identity-worker job id — the client polling key. */
  id: string;
  /** The provider's job id — callback/poll correlation. */
  providerJobId: string;
  participantId: string;
  /** Role snapshot at submission (written to the enrollment row on completion). */
  role: string;
  kind: "enrollment" | "authentication";
  status: "pending" | "passed" | "failed";
  failureReason: string | null;
  /** jti of the session issued when a passed authentication job was collected. */
  sessionTokenId: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface DeviceCredentialRow {
  id: string;
  participantId: string;
  credentialType: "fido" | "device-key";
  publicKey: string | null;
  secretHash: string | null;
  deviceLabel: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface AuthSessionRow {
  tokenId: string;
  participantId: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface DeviceResetRequestRow {
  id: string;
  participantId: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}

export interface FaceAuthAttemptRow {
  id: string;
  participantId: string;
  outcome: "pass" | "fail";
  similarityBucket: "low" | "medium" | "high" | null;
  createdAt: Date;
}

export interface IdentityStore {
  getFaceEnrollment(participantId: string): Promise<FaceEnrollmentRow | null>;
  upsertFaceEnrollment(row: FaceEnrollmentRow): Promise<void>;
  markFaceVerified(participantId: string, at: Date): Promise<void>;

  /** The live (unrevoked) credential for (participant, type), if any. */
  getLiveCredential(participantId: string, credentialType: string): Promise<DeviceCredentialRow | null>;
  getCredentialById(id: string): Promise<DeviceCredentialRow | null>;
  /** Insert when no row exists for (participant, type), otherwise replace it in place (upsert semantics). */
  putDeviceCredential(row: DeviceCredentialRow): Promise<void>;
  revokeDeviceCredentials(participantId: string, at: Date): Promise<number>;

  insertAuthSession(row: AuthSessionRow): Promise<void>;
  getAuthSession(tokenId: string): Promise<AuthSessionRow | null>;
  revokeAuthSessions(participantId: string, at: Date): Promise<number>;

  insertDeviceResetRequest(row: DeviceResetRequestRow): Promise<void>;
  getDeviceResetRequest(id: string): Promise<DeviceResetRequestRow | null>;
  /** The reset queue, oldest first; filtered by status when given (the ops console lists `pending`). */
  listDeviceResetRequests(status?: DeviceResetRequestRow["status"]): Promise<DeviceResetRequestRow[]>;
  resolveDeviceResetRequest(id: string, status: "approved" | "rejected", resolvedBy: string, at: Date): Promise<void>;

  insertFaceAuthAttempt(row: FaceAuthAttemptRow): Promise<void>;

  insertFaceAuthJob(row: FaceAuthJobRow): Promise<void>;
  getFaceAuthJob(id: string): Promise<FaceAuthJobRow | null>;
  getFaceAuthJobByProviderId(providerJobId: string): Promise<FaceAuthJobRow | null>;
  /**
   * Complete a PENDING job. Returns false when the row was already terminal —
   * callbacks are at-least-once, so double-completion must be a no-op.
   */
  completeFaceAuthJob(
    id: string,
    status: "passed" | "failed",
    failureReason: string | null,
    at: Date,
  ): Promise<boolean>;
  /** Record the session issued when a passed authentication job was collected. */
  setFaceAuthJobSession(id: string, sessionTokenId: string): Promise<void>;
}

/* ------------------------------------------------------------------------ */
/* Drizzle / Postgres implementation (production)                            */
/* ------------------------------------------------------------------------ */

type Db = PostgresJsDatabase<typeof schema>;

export function createDrizzleStore(db: Db): IdentityStore {
  return {
    async getFaceEnrollment(participantId) {
      const rows = await db.select().from(faceEnrollments).where(eq(faceEnrollments.participantId, participantId));
      const row = rows[0];
      if (!row) return null;
      return {
        participantId: row.participantId,
        role: row.role,
        embeddingEncrypted: row.embeddingEncrypted,
        iv: row.iv,
        authTag: row.authTag,
        modelVersion: row.modelVersion,
        providerRef: row.providerRef,
        createdAt: row.createdAt,
        lastVerifiedAt: row.lastVerifiedAt,
      };
    },
    async upsertFaceEnrollment(row) {
      await db
        .insert(faceEnrollments)
        .values(row)
        .onConflictDoUpdate({
          target: faceEnrollments.participantId,
          set: {
            role: row.role,
            embeddingEncrypted: row.embeddingEncrypted,
            iv: row.iv,
            authTag: row.authTag,
            modelVersion: row.modelVersion,
            providerRef: row.providerRef,
            createdAt: row.createdAt,
            lastVerifiedAt: null,
          },
        });
    },
    async markFaceVerified(participantId, at) {
      await db.update(faceEnrollments).set({ lastVerifiedAt: at }).where(eq(faceEnrollments.participantId, participantId));
    },

    async getLiveCredential(participantId, credentialType) {
      const rows = await db
        .select()
        .from(deviceCredentials)
        .where(eq(deviceCredentials.participantId, participantId));
      const row = rows.find((r) => r.credentialType === credentialType && r.revokedAt === null);
      return row ? toCredentialRow(row) : null;
    },
    async getCredentialById(id) {
      const rows = await db.select().from(deviceCredentials).where(eq(deviceCredentials.id, id));
      return rows[0] ? toCredentialRow(rows[0]) : null;
    },
    async putDeviceCredential(row) {
      await db
        .insert(deviceCredentials)
        .values(row)
        .onConflictDoUpdate({
          target: [deviceCredentials.participantId, deviceCredentials.credentialType],
          set: {
            id: row.id,
            publicKey: row.publicKey,
            secretHash: row.secretHash,
            deviceLabel: row.deviceLabel,
            createdAt: row.createdAt,
            revokedAt: null,
          },
        });
    },
    async revokeDeviceCredentials(participantId, at) {
      const updated = await db
        .update(deviceCredentials)
        .set({ revokedAt: at })
        .where(eq(deviceCredentials.participantId, participantId))
        .returning({ id: deviceCredentials.id });
      return updated.length;
    },

    async insertAuthSession(row) {
      await db.insert(authSessions).values(row);
    },
    async getAuthSession(tokenId) {
      const rows = await db.select().from(authSessions).where(eq(authSessions.tokenId, tokenId));
      return rows[0] ?? null;
    },
    async revokeAuthSessions(participantId, at) {
      const updated = await db
        .update(authSessions)
        .set({ revokedAt: at })
        .where(eq(authSessions.participantId, participantId))
        .returning({ tokenId: authSessions.tokenId });
      return updated.length;
    },

    async insertDeviceResetRequest(row) {
      await db.insert(deviceResetRequests).values(row);
    },
    async getDeviceResetRequest(id) {
      const rows = await db.select().from(deviceResetRequests).where(eq(deviceResetRequests.id, id));
      const row = rows[0];
      return row ? { ...row, status: row.status as DeviceResetRequestRow["status"] } : null;
    },
    async listDeviceResetRequests(status) {
      const rows = await db
        .select()
        .from(deviceResetRequests)
        .where(status ? eq(deviceResetRequests.status, status) : undefined)
        .orderBy(asc(deviceResetRequests.createdAt));
      return rows.map((row) => ({ ...row, status: row.status as DeviceResetRequestRow["status"] }));
    },
    async resolveDeviceResetRequest(id, status, resolvedBy, at) {
      await db
        .update(deviceResetRequests)
        .set({ status, resolvedBy, resolvedAt: at })
        .where(eq(deviceResetRequests.id, id));
    },

    async insertFaceAuthAttempt(row) {
      await db.insert(faceAuthAttempts).values(row);
    },

    async insertFaceAuthJob(row) {
      await db.insert(faceAuthJobs).values(row);
    },
    async getFaceAuthJob(id) {
      const rows = await db.select().from(faceAuthJobs).where(eq(faceAuthJobs.id, id));
      return rows[0] ? toFaceAuthJobRow(rows[0]) : null;
    },
    async getFaceAuthJobByProviderId(providerJobId) {
      const rows = await db.select().from(faceAuthJobs).where(eq(faceAuthJobs.providerJobId, providerJobId));
      return rows[0] ? toFaceAuthJobRow(rows[0]) : null;
    },
    async completeFaceAuthJob(id, status, failureReason, at) {
      const updated = await db
        .update(faceAuthJobs)
        .set({ status, failureReason, completedAt: at })
        .where(and(eq(faceAuthJobs.id, id), eq(faceAuthJobs.status, "pending")))
        .returning({ id: faceAuthJobs.id });
      return updated.length === 1;
    },
    async setFaceAuthJobSession(id, sessionTokenId) {
      await db.update(faceAuthJobs).set({ sessionTokenId }).where(eq(faceAuthJobs.id, id));
    },
  };
}

function toFaceAuthJobRow(row: typeof faceAuthJobs.$inferSelect): FaceAuthJobRow {
  return {
    id: row.id,
    providerJobId: row.providerJobId,
    participantId: row.participantId,
    role: row.role,
    kind: row.kind as FaceAuthJobRow["kind"],
    status: row.status as FaceAuthJobRow["status"],
    failureReason: row.failureReason,
    sessionTokenId: row.sessionTokenId,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

function toCredentialRow(row: typeof deviceCredentials.$inferSelect): DeviceCredentialRow {
  return {
    id: row.id,
    participantId: row.participantId,
    credentialType: row.credentialType as DeviceCredentialRow["credentialType"],
    publicKey: row.publicKey,
    secretHash: row.secretHash,
    deviceLabel: row.deviceLabel,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}
