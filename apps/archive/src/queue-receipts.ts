import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ArchiveQueueResponseSchema, type ArchiveQueueMessage, type ArchiveQueueStatus } from "@market-runs/proto";
import { archiveQueueMessages } from "../../../infra/drizzle/schema.js";
import type { ArchiveTx } from "./persist.js";
import type { ListParams } from "./admin.js";

export async function recordArchiveQueueReceipt(
  tx: ArchiveTx,
  input: {
    id: string;
    eventType: string;
    status: ArchiveQueueStatus;
    requestId?: string;
    error?: string;
  },
): Promise<void> {
  const now = new Date();
  const completedAt = input.status === "persisted" || input.status === "rejected" ? now : null;
  await tx.insert(archiveQueueMessages).values({
    id: input.id,
    eventType: input.eventType,
    status: input.status,
    attempts: 1,
    requestId: input.requestId ?? null,
    error: input.error ?? null,
    firstReceivedAt: now,
    updatedAt: now,
    completedAt,
  }).onConflictDoUpdate({
    target: archiveQueueMessages.id,
    set: {
      eventType: input.eventType,
      status: input.status,
      attempts: input.status === "received" ? sql`${archiveQueueMessages.attempts} + 1` : archiveQueueMessages.attempts,
      requestId: input.requestId ?? null,
      error: input.error ?? null,
      updatedAt: now,
      completedAt,
    },
  });
}

export function archiveQueueEntry(row: typeof archiveQueueMessages.$inferSelect): ArchiveQueueMessage {
  return {
    id: row.id,
    eventType: row.eventType,
    status: row.status as ArchiveQueueStatus,
    attempts: row.attempts,
    requestId: row.requestId,
    error: row.error,
    firstReceivedAt: row.firstReceivedAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    completedAt: row.completedAt?.getTime() ?? null,
  };
}

export async function listArchiveQueue(
  tx: ArchiveTx,
  filters: { status: ArchiveQueueStatus | null; eventType: string | null },
  params: ListParams,
): Promise<ReturnType<typeof ArchiveQueueResponseSchema.parse>> {
  const conditions = [];
  if (filters.status) conditions.push(eq(archiveQueueMessages.status, filters.status));
  if (filters.eventType) conditions.push(eq(archiveQueueMessages.eventType, filters.eventType));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await tx.select().from(archiveQueueMessages).where(where).orderBy(desc(archiveQueueMessages.updatedAt)).limit(params.limit).offset(params.offset);
  const countRows = await tx.select({ count: sql<number>`count(*)::int` }).from(archiveQueueMessages).where(where);
  const summaryRows = await tx.select({ status: archiveQueueMessages.status, count: sql<number>`count(*)::int` }).from(archiveQueueMessages).groupBy(archiveQueueMessages.status);
  const oldestRows = await tx.select({ oldest: sql<Date | null>`min(${archiveQueueMessages.firstReceivedAt})` }).from(archiveQueueMessages)
    .where(inArray(archiveQueueMessages.status, ["received", "retrying"]));
  const counts = Object.fromEntries(summaryRows.map((row) => [row.status, row.count]));
  return ArchiveQueueResponseSchema.parse({
    items: rows.map(archiveQueueEntry),
    total: countRows[0]?.count ?? 0,
    ...params,
    summary: {
      received: counts.received ?? 0,
      persisted: counts.persisted ?? 0,
      retrying: counts.retrying ?? 0,
      rejected: counts.rejected ?? 0,
      oldestUnresolvedAt: oldestRows[0]?.oldest?.getTime() ?? null,
    },
  });
}
