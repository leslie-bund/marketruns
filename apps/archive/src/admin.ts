import { and, arrayContains, desc, eq, isNull, sql } from "drizzle-orm";
import { computeOpsHealth, type OpsRunFact } from "@market-runs/domain";
import {
  AdminListSchema,
  AdminRunEntrySchema,
  AdminRunSummarySchema,
  DisputeViewSchema,
  LedgerViewSchema,
  LiveRunSchema,
  OpsHealthSchema,
  type AdminRunEntry,
  type AdminRunSummary,
  type DisputeView,
  type LedgerView,
  type LiveRun,
  type OpsHealth,
  type SettlementView,
  SettlementViewSchema,
} from "@market-runs/proto";
import { z } from "zod";
import {
  disputes,
  ledgerEntries,
  liveRuns,
  runsArchive,
  settlementRecords,
} from "../../../infra/drizzle/schema.js";
import type { ArchiveTx } from "./persist.js";

/**
 * Admin operational/oversight read path: zod-validated JSON list views over
 * the Postgres system of record (ADR-0011) plus the ADR-0013 expansion-gate
 * metrics. All queries run at request time inside db.transaction(...); all
 * wire timestamps are epoch milliseconds (packages/proto convention) and all
 * money stays integer kobo.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface ListParams {
  limit: number;
  offset: number;
}

/** limit/offset shared by every /admin/* list endpoint. */
export function parseListParams(url: URL): ListParams | Response {
  const limitRaw = url.searchParams.get("limit");
  const offsetRaw = url.searchParams.get("offset");
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return Response.json(
      { error: "invalid-query", message: `limit must be an integer between 1 and ${MAX_LIMIT}` },
      { status: 400 },
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return Response.json({ error: "invalid-query", message: "offset must be a non-negative integer" }, { status: 400 });
  }
  return { limit, offset };
}

export function optionalFilter(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  return value === null || value === "" ? null : value;
}

/**
 * Optional /admin/runs source filter: `kind=live` reads only the live_runs
 * index (runner run discovery), `kind=archived` only the retirement archive.
 * Absent = the merged union the dashboard expects.
 */
export function parseRunKindFilter(url: URL): "live" | "archived" | null | Response {
  const raw = url.searchParams.get("kind");
  if (raw === null || raw === "") return null;
  if (raw === "live" || raw === "archived") return raw;
  return Response.json(
    { error: "invalid-query", message: "kind must be 'live' or 'archived'" },
    { status: 400 },
  );
}

/* ------------------------------------------------------------------------ */
/* Row → wire shaping (pure, unit-tested)                                    */
/* ------------------------------------------------------------------------ */

type LiveRunRow = typeof liveRuns.$inferSelect;
type RunsArchiveRow = typeof runsArchive.$inferSelect;

export function liveRunEntry(row: LiveRunRow): LiveRun {
  return LiveRunSchema.parse({
    kind: "live",
    runId: row.runId,
    market: row.market,
    status: row.status,
    runnerId: row.runnerId,
    buyerId: row.buyerId,
    startedAt: row.startedAt.getTime(),
    retiredAt: row.retiredAt?.getTime() ?? null,
    stopCount: row.stopCount,
    storeIds: row.storeIds,
  });
}

export function adminRunSummary(row: RunsArchiveRow): AdminRunSummary {
  return AdminRunSummarySchema.parse({
    kind: "archived",
    runId: row.id,
    cartId: row.cartId,
    market: row.marketId,
    buyerId: row.buyerId,
    runnerId: row.runnerId,
    status: row.status,
    floorRateKobo: row.floorRateKobo,
    startedAt: row.startedAt?.getTime() ?? null,
    finalDeliveryAt: row.finalDeliveryAt?.getTime() ?? null,
    closedAt: row.closedAt.getTime(),
  });
}

function entrySortKey(entry: AdminRunEntry): number {
  return entry.kind === "live" ? entry.startedAt : entry.closedAt;
}

/**
 * Merge the live and archived run lists into one page, newest first. Both
 * sources are fetched in full for the filtered market (single-market MVP
 * scale); pagination is applied to the merged list.
 */
export function mergeRunEntries(
  live: LiveRunRow[],
  archived: RunsArchiveRow[],
  params: ListParams,
): { items: AdminRunEntry[]; total: number; limit: number; offset: number } {
  const entries: AdminRunEntry[] = [
    ...live.map(liveRunEntry),
    ...archived.map(adminRunSummary),
  ].sort((a, b) => entrySortKey(b) - entrySortKey(a));
  return {
    items: entries.slice(params.offset, params.offset + params.limit),
    total: entries.length,
    limit: params.limit,
    offset: params.offset,
  };
}

/* ------------------------------------------------------------------------ */
/* GET /admin/runs                                                           */
/* ------------------------------------------------------------------------ */

const AdminRunsResponseSchema = AdminListSchema(AdminRunEntrySchema);

export async function listAdminRuns(
  tx: ArchiveTx,
  filters: {
    market: string | null;
    status: string | null;
    runnerId: string | null;
    storeId: string | null;
    kind: "live" | "archived" | null;
  },
  params: ListParams,
): Promise<z.infer<typeof AdminRunsResponseSchema>> {
  const liveConditions = [isNull(liveRuns.retiredAt)];
  if (filters.market !== null) liveConditions.push(eq(liveRuns.market, filters.market));
  if (filters.status !== null) liveConditions.push(eq(liveRuns.status, filters.status));
  if (filters.runnerId !== null) liveConditions.push(eq(liveRuns.runnerId, filters.runnerId));
  // Additive seller-discovery filter: only live_runs carries store_ids, so a
  // storeId filter scopes the read to live rows containing the store —
  // archived runs stay reachable per store via archived_products.
  if (filters.storeId !== null) liveConditions.push(arrayContains(liveRuns.storeIds, [filters.storeId]));
  const live =
    filters.kind === "archived"
      ? []
      : await tx
          .select()
          .from(liveRuns)
          .where(and(...liveConditions))
          .orderBy(desc(liveRuns.startedAt));

  const archiveConditions = [];
  if (filters.market !== null) archiveConditions.push(eq(runsArchive.marketId, filters.market));
  if (filters.status !== null) archiveConditions.push(eq(runsArchive.status, filters.status));
  if (filters.runnerId !== null) archiveConditions.push(eq(runsArchive.runnerId, filters.runnerId));
  const archived =
    filters.kind === "live" || filters.storeId !== null
      ? []
      : await tx
          .select()
          .from(runsArchive)
          .where(archiveConditions.length > 0 ? and(...archiveConditions) : undefined)
          .orderBy(desc(runsArchive.closedAt));

  return AdminRunsResponseSchema.parse(mergeRunEntries(live, archived, params));
}

/* ------------------------------------------------------------------------ */
/* GET /admin/disputes                                                       */
/* ------------------------------------------------------------------------ */

const AdminDisputesResponseSchema = AdminListSchema(DisputeViewSchema);

export async function listAdminDisputes(
  tx: ArchiveTx,
  filters: { status: string | null },
  params: ListParams,
): Promise<z.infer<typeof AdminDisputesResponseSchema>> {
  const conditions = filters.status !== null ? [eq(disputes.status, filters.status)] : [];
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await tx
    .select({ dispute: disputes, market: runsArchive.marketId })
    .from(disputes)
    .innerJoin(runsArchive, eq(disputes.runId, runsArchive.id))
    .where(where)
    .orderBy(desc(disputes.createdAt))
    .limit(params.limit)
    .offset(params.offset);

  const countRows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(disputes)
    .where(where);
  const total = countRows[0]?.count ?? 0;

  const items: DisputeView[] = rows.map((row) => ({
    id: row.dispute.id,
    runId: row.dispute.runId,
    market: row.market,
    settlementRecordId: row.dispute.settlementRecordId,
    raisedByParticipantId: row.dispute.raisedByParticipantId,
    reason: row.dispute.reason,
    evidenceRefs: row.dispute.evidenceRefs,
    ambiguous: row.dispute.ambiguous,
    absorbedLossKobo: row.dispute.absorbedLossKobo,
    status: row.dispute.status as DisputeView["status"],
    createdAt: row.dispute.createdAt.getTime(),
    resolvedAt: row.dispute.resolvedAt?.getTime() ?? null,
  }));
  return AdminDisputesResponseSchema.parse({ items, total, ...params });
}

/* ------------------------------------------------------------------------ */
/* GET /admin/settlements                                                    */
/* ------------------------------------------------------------------------ */

const AdminSettlementsResponseSchema = AdminListSchema(SettlementViewSchema);

export async function listAdminSettlements(
  tx: ArchiveTx,
  filters: { market: string | null },
  params: ListParams,
): Promise<z.infer<typeof AdminSettlementsResponseSchema>> {
  const conditions = filters.market !== null ? [eq(runsArchive.marketId, filters.market)] : [];
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await tx
    .select({ record: settlementRecords, market: runsArchive.marketId })
    .from(settlementRecords)
    .innerJoin(runsArchive, eq(settlementRecords.runId, runsArchive.id))
    .where(where)
    .orderBy(desc(settlementRecords.releasedAt))
    .limit(params.limit)
    .offset(params.offset);

  const countRows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(settlementRecords)
    .innerJoin(runsArchive, eq(settlementRecords.runId, runsArchive.id))
    .where(where);
  const total = countRows[0]?.count ?? 0;

  const items: SettlementView[] = rows.map((row) => ({
    id: row.record.id,
    runId: row.record.runId,
    market: row.market,
    mode: row.record.mode as SettlementView["mode"],
    goodsTotalKobo: row.record.goodsTotalKobo,
    runnerKobo: row.record.runnerKobo,
    platformKobo: row.record.platformKobo,
    buyerRefundKobo: row.record.buyerRefundKobo,
    platformLossKobo: row.record.platformLossKobo,
    releasedAt: row.record.releasedAt.getTime(),
  }));
  return AdminSettlementsResponseSchema.parse({ items, total, ...params });
}

/* ------------------------------------------------------------------------ */
/* GET /admin/ledger                                                         */
/* ------------------------------------------------------------------------ */

const AdminLedgerResponseSchema = AdminListSchema(LedgerViewSchema);

export async function listAdminLedger(
  tx: ArchiveTx,
  filters: { market: string | null },
  params: ListParams,
): Promise<z.infer<typeof AdminLedgerResponseSchema>> {
  const conditions = filters.market !== null ? [eq(runsArchive.marketId, filters.market)] : [];
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const base = () =>
    tx
      .select({
        entry: ledgerEntries,
        runId: settlementRecords.runId,
        market: runsArchive.marketId,
      })
      .from(ledgerEntries)
      .innerJoin(settlementRecords, eq(ledgerEntries.settlementRecordId, settlementRecords.id))
      .innerJoin(runsArchive, eq(settlementRecords.runId, runsArchive.id))
      .where(where);

  const rows = await base().orderBy(desc(ledgerEntries.createdAt)).limit(params.limit).offset(params.offset);

  const countRows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(ledgerEntries)
    .innerJoin(settlementRecords, eq(ledgerEntries.settlementRecordId, settlementRecords.id))
    .innerJoin(runsArchive, eq(settlementRecords.runId, runsArchive.id))
    .where(where);
  const total = countRows[0]?.count ?? 0;

  const items: LedgerView[] = rows.map((row) => ({
    id: row.entry.id,
    settlementRecordId: row.entry.settlementRecordId,
    runId: row.runId,
    market: row.market,
    account: row.entry.account,
    partyId: row.entry.partyId,
    debitKobo: row.entry.debitKobo,
    creditKobo: row.entry.creditKobo,
    memo: row.entry.memo,
    createdAt: row.entry.createdAt.getTime(),
  }));
  return AdminLedgerResponseSchema.parse({ items, total, ...params });
}

/* ------------------------------------------------------------------------ */
/* GET /admin/ops-health — the ADR-0013 expansion gate                       */
/* ------------------------------------------------------------------------ */

export function parseOpsHealthQuery(url: URL): { market: string } | Response {
  const market = url.searchParams.get("market");
  if (!market) {
    return Response.json({ error: "invalid-query", message: "market query param is required" }, { status: 400 });
  }
  return { market };
}

/**
 * Gate facts for one market: one row per archived run, taking the LATEST
 * settlement when appeals produced several (schema README: consumers take the
 * latest). Runs without a released settlement fall back to their close status
 * for the mode, mirroring the reputation read path.
 */
export async function loadOpsRunFacts(tx: ArchiveTx, market: string): Promise<OpsRunFact[]> {
  const rows = await tx
    .select({
      runId: runsArchive.id,
      buyerId: runsArchive.buyerId,
      status: runsArchive.status,
      closedAt: runsArchive.closedAt,
      mode: settlementRecords.mode,
      disputeId: disputes.id,
    })
    .from(runsArchive)
    .leftJoin(
      settlementRecords,
      and(eq(settlementRecords.runId, runsArchive.id)),
    )
    .leftJoin(disputes, eq(disputes.runId, runsArchive.id))
    .where(eq(runsArchive.marketId, market))
    .orderBy(desc(settlementRecords.releasedAt));

  const facts = new Map<string, OpsRunFact>();
  for (const row of rows) {
    const existing = facts.get(row.runId);
    const mode: OpsRunFact["mode"] =
      row.mode === "completed" || row.mode === "aborted" || row.mode === "disputed"
        ? row.mode
        : row.status === "aborted"
          ? "aborted"
          : "completed";
    const opsIntervention = mode === "disputed" || row.disputeId !== null;
    if (existing) {
      // Later rows for the same run are older settlements or additional
      // dispute rows: keep the latest mode, accumulate the dispute signal.
      existing.opsIntervention = existing.opsIntervention || opsIntervention;
      continue;
    }
    facts.set(row.runId, {
      runId: row.runId,
      buyerId: row.buyerId,
      closedAt: row.closedAt.getTime(),
      mode,
      opsIntervention,
    });
  }
  return [...facts.values()];
}

export async function loadOpsHealth(tx: ArchiveTx, market: string): Promise<OpsHealth> {
  const facts = await loadOpsRunFacts(tx, market);
  const health = computeOpsHealth(facts);
  return OpsHealthSchema.parse({ market, ...health, computedAt: Date.now() });
}
