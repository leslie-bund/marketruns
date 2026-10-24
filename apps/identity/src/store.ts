import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  authSessions, biometricConsentReceipts, deviceCredentials, deviceResetRequests, faceAuthAttempts,
  faceAuthJobs, faceEnrollments, identityAccessProofs, identityParticipants,
} from "../../../infra/drizzle/schema.js";
import type * as schema from "../../../infra/drizzle/schema.js";

export interface IdentityParticipantRow {
  participantId: string; role: string; kycStatus: "preverified" | "verified";
  displayName: string; verifiedLegalName: string | null; createdAt: Date; updatedAt: Date;
}
export interface IdentityAccessProofRow {
  id: string; proofHash: string; participantId: string; purpose: "enrollment" | "recovery";
  expiresAt: Date; consumedAt: Date | null; createdAt: Date;
}
export interface BiometricConsentRow {
  id: string; participantId: string; purpose: string; version: string; grantedAt: Date; createdAt: Date;
}
export interface FaceEnrollmentRow {
  participantId: string; role: string; embeddingEncrypted: Uint8Array | null; iv: Uint8Array | null;
  authTag: Uint8Array | null; modelVersion: string; providerRef: string | null;
  createdAt: Date; lastVerifiedAt: Date | null;
}
export interface FaceAuthJobRow {
  id: string; providerJobId: string; participantId: string; role: string;
  kind: "enrollment" | "authentication"; status: "pending" | "passed" | "failed";
  failureReason: string | null; sessionTokenId: string | null;
  pendingEmbeddingEncrypted: Uint8Array | null; pendingEmbeddingIv: Uint8Array | null;
  pendingEmbeddingAuthTag: Uint8Array | null; pendingModelVersion: string | null;
  expiresAt: Date; createdAt: Date; completedAt: Date | null;
}
export interface DeviceCredentialRow {
  id: string; participantId: string; credentialType: "fido" | "device-key"; publicKey: string | null;
  secretHash: string | null; deviceLabel: string | null; createdAt: Date; revokedAt: Date | null;
}
export interface AuthSessionRow {
  tokenId: string; participantId: string; issuedAt: Date; expiresAt: Date; revokedAt: Date | null;
}
export interface DeviceResetRequestRow {
  id: string; participantId: string; reason: string; status: "pending" | "approved" | "rejected";
  createdAt: Date; resolvedAt: Date | null; resolvedBy: string | null;
}
export interface FaceAuthAttemptRow {
  id: string; participantId: string; outcome: "pass" | "fail";
  similarityBucket: "low" | "medium" | "high" | null; createdAt: Date;
}

export interface IdentityStore {
  getIdentityParticipant(id: string): Promise<IdentityParticipantRow | null>;
  putIdentityParticipant(row: IdentityParticipantRow): Promise<void>;
  completeIdentityKyc(id: string, verifiedLegalName: string | null, at: Date): Promise<void>;
  updateDisplayName(id: string, displayName: string, at: Date): Promise<void>;
  insertAccessProof(row: IdentityAccessProofRow): Promise<void>;
  getAccessProof(proofHash: string): Promise<IdentityAccessProofRow | null>;
  consumeAccessProof(id: string, at: Date): Promise<boolean>;
  insertBiometricConsent(row: BiometricConsentRow): Promise<void>;
  getFaceEnrollment(id: string): Promise<FaceEnrollmentRow | null>;
  upsertFaceEnrollment(row: FaceEnrollmentRow): Promise<void>;
  markFaceVerified(id: string, at: Date): Promise<void>;
  getLiveCredential(id: string, type: string): Promise<DeviceCredentialRow | null>;
  getCredentialById(id: string): Promise<DeviceCredentialRow | null>;
  putDeviceCredential(row: DeviceCredentialRow): Promise<void>;
  revokeDeviceCredentials(id: string, at: Date): Promise<number>;
  insertAuthSession(row: AuthSessionRow): Promise<void>;
  getAuthSession(id: string): Promise<AuthSessionRow | null>;
  revokeAuthSessions(id: string, at: Date): Promise<number>;
  insertDeviceResetRequest(row: DeviceResetRequestRow): Promise<void>;
  getDeviceResetRequest(id: string): Promise<DeviceResetRequestRow | null>;
  listDeviceResetRequests(status?: DeviceResetRequestRow["status"]): Promise<DeviceResetRequestRow[]>;
  resolveDeviceResetRequest(id: string, status: "approved" | "rejected", by: string, at: Date): Promise<void>;
  insertFaceAuthAttempt(row: FaceAuthAttemptRow): Promise<void>;
  countRecentFaceFailures(id: string, since: Date): Promise<number>;
  insertFaceAuthJob(row: FaceAuthJobRow): Promise<void>;
  getFaceAuthJob(id: string): Promise<FaceAuthJobRow | null>;
  getFaceAuthJobByProviderId(id: string): Promise<FaceAuthJobRow | null>;
  completeFaceAuthJob(id: string, status: "passed" | "failed", reason: string | null, at: Date): Promise<boolean>;
  setFaceAuthJobSession(id: string, tokenId: string): Promise<void>;
}

type Db = PostgresJsDatabase<typeof schema>;
export function createDrizzleStore(db: Db): IdentityStore {
  return {
    async getIdentityParticipant(id) {
      const row = (await db.select().from(identityParticipants).where(eq(identityParticipants.participantId, id)))[0];
      return row ? { ...row, kycStatus: row.kycStatus as IdentityParticipantRow["kycStatus"] } : null;
    },
    async putIdentityParticipant(row) {
      await db.insert(identityParticipants).values(row).onConflictDoUpdate({
        target: identityParticipants.participantId,
        set: { role: row.role, displayName: row.displayName, kycStatus: row.kycStatus, updatedAt: row.updatedAt },
      });
    },
    async completeIdentityKyc(id, verifiedLegalName, at) {
      await db.update(identityParticipants).set({
        kycStatus: "verified", verifiedLegalName: sql`coalesce(${identityParticipants.verifiedLegalName}, ${verifiedLegalName})`, updatedAt: at,
      }).where(eq(identityParticipants.participantId, id));
    },
    async updateDisplayName(id, displayName, at) {
      await db.update(identityParticipants).set({ displayName, updatedAt: at }).where(eq(identityParticipants.participantId, id));
    },
    async insertAccessProof(row) { await db.insert(identityAccessProofs).values(row); },
    async getAccessProof(hash) {
      const row = (await db.select().from(identityAccessProofs).where(eq(identityAccessProofs.proofHash, hash)))[0];
      return row ? { ...row, purpose: row.purpose as IdentityAccessProofRow["purpose"] } : null;
    },
    async consumeAccessProof(id, at) {
      const rows = await db.update(identityAccessProofs).set({ consumedAt: at })
        .where(and(eq(identityAccessProofs.id, id), isNull(identityAccessProofs.consumedAt))).returning({ id: identityAccessProofs.id });
      return rows.length === 1;
    },
    async insertBiometricConsent(row) { await db.insert(biometricConsentReceipts).values(row); },
    async getFaceEnrollment(id) {
      return (await db.select().from(faceEnrollments).where(eq(faceEnrollments.participantId, id)))[0] ?? null;
    },
    async upsertFaceEnrollment(row) {
      await db.insert(faceEnrollments).values(row).onConflictDoUpdate({
        target: faceEnrollments.participantId,
        set: { role: row.role, embeddingEncrypted: row.embeddingEncrypted, iv: row.iv, authTag: row.authTag,
          modelVersion: row.modelVersion, providerRef: row.providerRef, createdAt: row.createdAt, lastVerifiedAt: null },
      });
    },
    async markFaceVerified(id, at) { await db.update(faceEnrollments).set({ lastVerifiedAt: at }).where(eq(faceEnrollments.participantId, id)); },
    async getLiveCredential(id, type) {
      const rows = await db.select().from(deviceCredentials).where(eq(deviceCredentials.participantId, id));
      const row = rows.find((r) => r.credentialType === type && r.revokedAt === null);
      return row ? toCredential(row) : null;
    },
    async getCredentialById(id) {
      const row = (await db.select().from(deviceCredentials).where(eq(deviceCredentials.id, id)))[0];
      return row ? toCredential(row) : null;
    },
    async putDeviceCredential(row) {
      await db.insert(deviceCredentials).values(row).onConflictDoUpdate({
        target: [deviceCredentials.participantId, deviceCredentials.credentialType],
        set: { id: row.id, publicKey: row.publicKey, secretHash: row.secretHash, deviceLabel: row.deviceLabel,
          createdAt: row.createdAt, revokedAt: null },
      });
    },
    async revokeDeviceCredentials(id, at) {
      return (await db.update(deviceCredentials).set({ revokedAt: at }).where(eq(deviceCredentials.participantId, id)).returning({ id: deviceCredentials.id })).length;
    },
    async insertAuthSession(row) { await db.insert(authSessions).values(row); },
    async getAuthSession(id) { return (await db.select().from(authSessions).where(eq(authSessions.tokenId, id)))[0] ?? null; },
    async revokeAuthSessions(id, at) {
      return (await db.update(authSessions).set({ revokedAt: at }).where(eq(authSessions.participantId, id)).returning({ id: authSessions.tokenId })).length;
    },
    async insertDeviceResetRequest(row) { await db.insert(deviceResetRequests).values(row); },
    async getDeviceResetRequest(id) {
      const row = (await db.select().from(deviceResetRequests).where(eq(deviceResetRequests.id, id)))[0];
      return row ? { ...row, status: row.status as DeviceResetRequestRow["status"] } : null;
    },
    async listDeviceResetRequests(status) {
      const rows = await db.select().from(deviceResetRequests).where(status ? eq(deviceResetRequests.status, status) : undefined).orderBy(asc(deviceResetRequests.createdAt));
      return rows.map((row) => ({ ...row, status: row.status as DeviceResetRequestRow["status"] }));
    },
    async resolveDeviceResetRequest(id, status, by, at) {
      await db.update(deviceResetRequests).set({ status, resolvedBy: by, resolvedAt: at }).where(eq(deviceResetRequests.id, id));
    },
    async insertFaceAuthAttempt(row) { await db.insert(faceAuthAttempts).values(row); },
    async countRecentFaceFailures(id, since) {
      const rows = await db.select({ count: sql<number>`count(*)::int` }).from(faceAuthAttempts)
        .where(and(eq(faceAuthAttempts.participantId, id), eq(faceAuthAttempts.outcome, "fail"), gt(faceAuthAttempts.createdAt, since)));
      return rows[0]?.count ?? 0;
    },
    async insertFaceAuthJob(row) { await db.insert(faceAuthJobs).values(row); },
    async getFaceAuthJob(id) {
      const row = (await db.select().from(faceAuthJobs).where(eq(faceAuthJobs.id, id)))[0];
      return row ? toJob(row) : null;
    },
    async getFaceAuthJobByProviderId(id) {
      const row = (await db.select().from(faceAuthJobs).where(eq(faceAuthJobs.providerJobId, id)))[0];
      return row ? toJob(row) : null;
    },
    async completeFaceAuthJob(id, status, reason, at) {
      const rows = await db.update(faceAuthJobs).set({ status, failureReason: reason, completedAt: at,
        pendingEmbeddingEncrypted: null, pendingEmbeddingIv: null, pendingEmbeddingAuthTag: null })
        .where(and(eq(faceAuthJobs.id, id), eq(faceAuthJobs.status, "pending"))).returning({ id: faceAuthJobs.id });
      return rows.length === 1;
    },
    async setFaceAuthJobSession(id, tokenId) { await db.update(faceAuthJobs).set({ sessionTokenId: tokenId }).where(eq(faceAuthJobs.id, id)); },
  };
}
function toJob(row: typeof faceAuthJobs.$inferSelect): FaceAuthJobRow {
  return { ...row, kind: row.kind as FaceAuthJobRow["kind"], status: row.status as FaceAuthJobRow["status"] };
}
function toCredential(row: typeof deviceCredentials.$inferSelect): DeviceCredentialRow {
  return { ...row, credentialType: row.credentialType as DeviceCredentialRow["credentialType"] };
}
