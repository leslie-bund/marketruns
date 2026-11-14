import { and, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  AdminListSchema,
  RetainedMediaStatusSchema,
  RetainedMediaViewSchema,
  type IntentExpired,
  type ProductRetired,
  type RetainedMediaStatus,
  type RetainedMediaView,
  type RunRetired,
} from "@market-runs/proto";
import { retainedMedia, runsArchive } from "../../../infra/drizzle/schema.js";
import type { ArchiveTx } from "./persist.js";
import type { ListParams } from "./admin.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const UNACCEPTED_MEDIA_RETENTION_MS = 7 * DAY_MS;
export const ACCEPTED_MEDIA_RETENTION_MS = 90 * DAY_MS;
export const ACCEPTED_MEDIA_BACKSTOP_MS = ACCEPTED_MEDIA_RETENTION_MS + 7 * DAY_MS;

interface RetainedMediaDatabase {
  transaction<T>(callback: (tx: ArchiveTx) => Promise<T>): Promise<T>;
}

function captureObjectKey(ref: string): string | null {
  const prefix = "r2://archive/";
  if (!ref.startsWith(prefix) || ref.length === prefix.length) return null;
  return ref.slice(prefix.length);
}

export function retainedMediaDeleteAfter(message: ProductRetired | IntentExpired, runClosedAt?: number): number {
  if (runClosedAt !== undefined) return runClosedAt + ACCEPTED_MEDIA_RETENTION_MS;
  const retiredAt = message.type === "product.retired" ? message.retiredAt : message.expiredAt;
  const accepted = message.type === "product.retired" && message.reason === "sold";
  return retiredAt + (accepted ? ACCEPTED_MEDIA_BACKSTOP_MS : UNACCEPTED_MEDIA_RETENTION_MS);
}

export async function recordRetiredMedia(tx: ArchiveTx, message: ProductRetired | IntentExpired): Promise<void> {
  const snapshot = message.snapshot;
  if (!snapshot) return;
  const product = message.type === "product.retired" ? message : null;
  const run = product?.reason === "sold" && product.cartId
    ? (await tx.select({ id: runsArchive.id, closedAt: runsArchive.closedAt }).from(runsArchive).where(eq(runsArchive.cartId, product.cartId)).limit(1))[0]
    : undefined;
  const subjectType = message.type === "product.retired" ? "product" : "intent";
  const subjectId = message.type === "product.retired" ? message.productId : message.intentId;
  const retiredAt = message.type === "product.retired" ? message.retiredAt : message.expiredAt;
  const deleteAfter = new Date(retainedMediaDeleteAfter(message, run?.closedAt.getTime()));
  for (const [mediaKind, captureRef] of [["image", snapshot.photoCaptureRef], ["video", snapshot.videoCaptureRef]] as const) {
    if (!captureRef) continue;
    const objectKey = captureObjectKey(captureRef);
    if (!objectKey) continue;
    await tx.insert(retainedMedia).values({
      id: `${subjectType}:${subjectId}:${mediaKind}`,
      subjectType,
      subjectId,
      captureRef,
      objectKey,
      mediaKind,
      ownerId: message.type === "product.retired" ? message.snapshot.sellerParticipantId ?? null : message.snapshot?.buyerId ?? null,
      cartId: product?.cartId ?? null,
      runId: run?.id ?? null,
      status: "retained",
      retiredAt: new Date(retiredAt),
      deleteAfter,
      updatedAt: new Date(retiredAt),
    }).onConflictDoNothing();
  }
}

export async function markRunRetainedMediaClosed(tx: ArchiveTx, message: RunRetired): Promise<void> {
  await tx.update(retainedMedia).set({
    runId: message.runId,
    deleteAfter: new Date(message.closedAt + ACCEPTED_MEDIA_RETENTION_MS),
    updatedAt: new Date(message.closedAt),
  }).where(and(eq(retainedMedia.cartId, message.cartId), isNull(retainedMedia.deletedAt)));
}

function retainedMediaView(row: typeof retainedMedia.$inferSelect): RetainedMediaView {
  return RetainedMediaViewSchema.parse({
    ...row,
    retiredAt: row.retiredAt.getTime(),
    deleteAfter: row.deleteAfter.getTime(),
    heldAt: row.heldAt?.getTime() ?? null,
    deletedAt: row.deletedAt?.getTime() ?? null,
  });
}

export async function listRetainedMedia(
  tx: ArchiveTx,
  filters: { status: RetainedMediaStatus | null; subjectType: "product" | "intent" | null; subjectId: string | null; runId: string | null },
  params: ListParams,
) {
  const conditions = [];
  if (filters.status) conditions.push(eq(retainedMedia.status, filters.status));
  if (filters.subjectType) conditions.push(eq(retainedMedia.subjectType, filters.subjectType));
  if (filters.subjectId) conditions.push(eq(retainedMedia.subjectId, filters.subjectId));
  if (filters.runId) conditions.push(eq(retainedMedia.runId, filters.runId));
  const where = conditions.length ? and(...conditions) : undefined;
  const rows = await tx.select().from(retainedMedia).where(where).orderBy(desc(retainedMedia.updatedAt)).limit(params.limit).offset(params.offset);
  const countRows = await tx.select({ count: sql<number>`count(*)::int` }).from(retainedMedia).where(where);
  return AdminListSchema(RetainedMediaViewSchema).parse({
    items: rows.map(retainedMediaView),
    total: countRows[0]?.count ?? 0,
    ...params,
  });
}

export type RetainedMediaHoldResult = RetainedMediaView | "not-found" | "not-held" | "deleted" | "cleanup-in-progress";

export async function setRetainedMediaHold(
  tx: ArchiveTx,
  id: string,
  action: "hold" | "release",
  input?: { reason: string; heldBy: string },
): Promise<RetainedMediaHoldResult> {
  const [existing] = await tx.select().from(retainedMedia).where(eq(retainedMedia.id, id)).limit(1);
  if (!existing) return "not-found";
  if (existing.status === "deleted") return "deleted";
  if (existing.status === "deleting") return "cleanup-in-progress";
  const now = new Date();
  if (action === "hold") {
    if (!input) throw new Error("hold reason and actor are required");
    if (existing.status === "held") return retainedMediaView(existing);
    const [updated] = await tx.update(retainedMedia).set({
      status: "held",
      holdReason: input.reason,
      heldBy: input.heldBy,
      heldAt: now,
      updatedAt: now,
    }).where(and(eq(retainedMedia.id, id), eq(retainedMedia.status, "retained"))).returning();
    return updated ? retainedMediaView(updated) : "cleanup-in-progress";
  }
  if (existing.status !== "held") return "not-held";
  const [updated] = await tx.update(retainedMedia).set({ status: "retained", updatedAt: now })
    .where(and(eq(retainedMedia.id, id), eq(retainedMedia.status, "held"))).returning();
  return updated ? retainedMediaView(updated) : "cleanup-in-progress";
}

export async function cleanupExpiredRetainedMedia(
  db: RetainedMediaDatabase,
  bucket: R2Bucket,
  now = new Date(),
  limit = 100,
): Promise<{ claimed: number; deleted: number; failed: number }> {
  const claimed = await db.transaction(async (tx) => {
    const due = await tx.select({ id: retainedMedia.id }).from(retainedMedia)
      .where(and(eq(retainedMedia.status, "retained"), lte(retainedMedia.deleteAfter, now)))
      .orderBy(retainedMedia.deleteAfter).limit(limit);
    if (!due.length) return [];
    return tx.update(retainedMedia).set({ status: "deleting", updatedAt: now })
      .where(and(inArray(retainedMedia.id, due.map((row) => row.id)), eq(retainedMedia.status, "retained"), lte(retainedMedia.deleteAfter, now)))
      .returning({ id: retainedMedia.id, objectKey: retainedMedia.objectKey });
  });
  let deleted = 0;
  let failed = 0;
  for (const row of claimed) {
    try {
      await bucket.delete(row.objectKey);
      await db.transaction(async (tx) => {
        await tx.update(retainedMedia).set({ status: "deleted", deletedAt: now, updatedAt: now, lastError: null })
          .where(and(eq(retainedMedia.id, row.id), eq(retainedMedia.status, "deleting")));
      });
      deleted += 1;
    } catch (error) {
      failed += 1;
      await db.transaction(async (tx) => {
        await tx.update(retainedMedia).set({
          status: "retained",
          lastError: String(error).slice(0, 1000),
          updatedAt: new Date(),
        }).where(and(eq(retainedMedia.id, row.id), eq(retainedMedia.status, "deleting")));
      });
      console.error(JSON.stringify({ event: "archive.retained_media_delete_failed", mediaId: row.id, error: String(error) }));
    }
  }
  return { claimed: claimed.length, deleted, failed };
}

export function parseRetainedMediaStatus(value: string | null): RetainedMediaStatus | null | Response {
  if (value === null) return null;
  const parsed = RetainedMediaStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : Response.json({ error: "invalid-query", message: "unknown retained media status" }, { status: 400 });
}
