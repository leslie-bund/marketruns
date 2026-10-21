import { z } from "zod";
import { KoboSchema, TimestampSchema } from "./primitives.js";
import { RunSchema, RunStatusSchema } from "./run.js";
import { SettlementModeSchema } from "./settlement.js";

/**
 * Admin operational/oversight dashboard wire shapes. These are READ models
 * over the Postgres system of record (ADR-0011): the live_runs index, the
 * retirement archives, the settlement record, and the double-entry ledger.
 * They are never written by clients — the archive worker serves them
 * zod-validated. All money is integer kobo; all rates are basis points
 * (0–10 000), matching reputation standing.
 */

/** Basis points, 0–10 000 (100.00%). */
export const BpsSchema = z.number().int().min(0).max(10_000);
export type Bps = z.infer<typeof BpsSchema>;

/** Live-run index entry (live_runs table; retiredAt set when the run closes). */
export const LiveRunSchema = z.object({
  kind: z.literal("live"),
  runId: z.string().min(1),
  market: z.string().min(1),
  status: RunStatusSchema,
  /** NULL until a Runner is assigned. */
  runnerId: z.string().min(1).nullable(),
  buyerId: z.string().min(1),
  startedAt: TimestampSchema,
  retiredAt: TimestampSchema.nullable(),
  stopCount: z.number().int().nonnegative(),
  /** The stores with products in this run's cart (from run.started); powers seller run discovery. */
  storeIds: z.array(z.string().min(1)),
});
export type LiveRun = z.infer<typeof LiveRunSchema>;

/** Archived run row for list views — the useful fields of runs_archive. */
export const AdminRunSummarySchema = z.object({
  kind: z.literal("archived"),
  runId: z.string().min(1),
  cartId: z.string().min(1),
  market: z.string().min(1),
  buyerId: z.string().min(1),
  runnerId: z.string().min(1),
  status: RunStatusSchema,
  floorRateKobo: KoboSchema,
  startedAt: TimestampSchema.nullable(),
  finalDeliveryAt: TimestampSchema.nullable(),
  closedAt: TimestampSchema,
});
export type AdminRunSummary = z.infer<typeof AdminRunSummarySchema>;

/** One entry of the /admin/runs union view, discriminated on `kind`. */
export const AdminRunEntrySchema = z.discriminatedUnion("kind", [LiveRunSchema, AdminRunSummarySchema]);
export type AdminRunEntry = z.infer<typeof AdminRunEntrySchema>;

/** Dispute list row — disputes ⨝ runs_archive for market context. */
export const DisputeViewSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  market: z.string().min(1),
  /** NULL while the dispute is open (no settlement released for it yet). */
  settlementRecordId: z.string().min(1).nullable(),
  raisedByParticipantId: z.string().min(1),
  /** Why the dispute was raised (free text from the run.retired dispute block). */
  reason: z.string(),
  evidenceRefs: z.array(z.string()),
  ambiguous: z.boolean(),
  absorbedLossKobo: KoboSchema,
  status: z.enum(["open", "under_review", "resolved"]),
  createdAt: TimestampSchema,
  resolvedAt: TimestampSchema.nullable(),
});
export type DisputeView = z.infer<typeof DisputeViewSchema>;

/** Settlement list row — settlement_records ⨝ runs_archive for market context. */
export const SettlementViewSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  market: z.string().min(1),
  mode: SettlementModeSchema,
  goodsTotalKobo: KoboSchema,
  runnerKobo: KoboSchema,
  platformKobo: KoboSchema,
  buyerRefundKobo: KoboSchema,
  platformLossKobo: KoboSchema,
  releasedAt: TimestampSchema,
});
export type SettlementView = z.infer<typeof SettlementViewSchema>;

/** Ledger list row — ledger_entries ⨝ settlement_records ⨝ runs_archive. */
export const LedgerViewSchema = z.object({
  id: z.string().min(1),
  settlementRecordId: z.string().min(1),
  runId: z.string().min(1),
  market: z.string().min(1),
  account: z.string().min(1),
  /** Participant the leg concerns; NULL for platform accounts. */
  partyId: z.string().min(1).nullable(),
  debitKobo: KoboSchema,
  creditKobo: KoboSchema,
  memo: z.string(),
  createdAt: TimestampSchema,
});
export type LedgerView = z.infer<typeof LedgerViewSchema>;

/**
 * The live dispute block on the ops run detail (RunDO → ops console only).
 * Evidence merges server-side per ADR-0019 — participants never enumerate
 * these refs; this projection exists so ops can review the evidence BEFORE
 * picking an ops-settle mode, and never rides the client run wire.
 */
export const OpsRunDisputeSchema = z.object({
  reason: z.string(),
  raisedByParticipantId: z.string().min(1).nullable(),
  /** Raiser-attached refs merged with every handoff photo ref the run holds. */
  evidenceRefs: z.array(z.string()),
});
export type OpsRunDispute = z.infer<typeof OpsRunDisputeSchema>;

/** RunDO → ops console run detail (GET /ops/api/runs/:runId): the wire run plus its live dispute block. */
export const OpsRunDetailSchema = z.object({
  run: RunSchema,
  /** Present exactly when the run is disputed and not yet settled. */
  dispute: OpsRunDisputeSchema.nullable(),
});
export type OpsRunDetail = z.infer<typeof OpsRunDetailSchema>;

/** Paginated list envelope shared by every /admin/* list endpoint. */
export function AdminListSchema<Item extends z.ZodTypeAny>(itemSchema: Item) {
  return z.object({
    items: z.array(itemSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  });
}

/** One ADR-0013 gate metric: the threshold it is measured against and pass/fail. */
export const OpsGateMetricSchema = z.object({
  threshold: z.number().int().nonnegative(),
  pass: z.boolean(),
});
export type OpsGateMetric = z.infer<typeof OpsGateMetricSchema>;

/**
 * The ADR-0013 expansion-gate metrics for one market: 8 consecutive qualifying
 * weeks, ≥500 completed runs, <5% dispute rate, ≥60% zero-touch runs, ≥30
 * repeat buyers. Rates in basis points (dispute 5% = 500 bps; zero-touch
 * 60% = 6 000 bps). `gate.pass` is the AND of every per-metric pass.
 */
export const OpsHealthSchema = z.object({
  market: z.string().min(1),
  consecutiveQualifyingWeeks: z.number().int().nonnegative(),
  completedRuns: z.number().int().nonnegative(),
  disputeRateBps: BpsSchema,
  zeroTouchRateBps: BpsSchema,
  repeatBuyers: z.number().int().nonnegative(),
  gate: z.object({
    qualifyingWeeks: OpsGateMetricSchema,
    completedRuns: OpsGateMetricSchema,
    disputeRateBps: OpsGateMetricSchema,
    zeroTouchRateBps: OpsGateMetricSchema,
    repeatBuyers: OpsGateMetricSchema,
    pass: z.boolean(),
  }),
  computedAt: TimestampSchema,
});
export type OpsHealth = z.infer<typeof OpsHealthSchema>;
