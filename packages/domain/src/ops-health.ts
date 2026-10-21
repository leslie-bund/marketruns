import type { SettlementOutcomeMode } from "./reputation.js";

/**
 * The ADR-0013 expansion gate, computed pure over the durable record. The MVP
 * stays in one market until the gate passes: 8 consecutive qualifying weeks,
 * ≥500 completed runs, <5% dispute rate, ≥60% of runs completing with zero
 * ops intervention, ≥30 repeat buyers. Rates are basis points, matching
 * reputation standing.
 *
 * ADR-0013 does not define "qualifying week" precisely; the choices made here
 * (and relied on by the archive worker's /admin/ops-health endpoint):
 * - A week is a UTC Monday-aligned 7-day bucket of runs_archive.closed_at.
 * - A week QUALIFIES when it has at least one completed run and meets all the
 *   per-week-rate criteria: dispute rate strictly below 500 bps (<5%) and
 *   zero-touch rate at or above 6 000 bps (≥60%). A week with no runs
 *   demonstrates nothing, so it does not qualify and BREAKS the streak.
 * - consecutiveQualifyingWeeks counts back from the most recent week that
 *   contains a closed run, stopping at the first non-qualifying week.
 * - completedRuns (≥500) and repeatBuyers (≥30) are CUMULATIVE over the whole
 *   market history, not per-week: every run that reached a released
 *   settlement counts as a completed run (aborts and disputes are finished
 *   trips the gate's rates measure), and a repeat buyer is a buyer on more
 *   than one completed run.
 */

export const OPS_GATE_THRESHOLDS = {
  qualifyingWeeks: 8,
  completedRuns: 500,
  /** <5% dispute rate, basis points (comparison is strict). */
  disputeRateBps: 500,
  /** ≥60% zero-touch, basis points. */
  zeroTouchRateBps: 6_000,
  repeatBuyers: 30,
} as const;

/** One closed run's contribution to the gate, as recorded in Postgres. */
export interface OpsRunFact {
  runId: string;
  buyerId: string;
  /** runs_archive.closed_at, epoch milliseconds. */
  closedAt: number;
  mode: SettlementOutcomeMode;
  /**
   * Ops-intervention proxy: TRUE when the run closed via a disputed
   * (ops-settled) settlement or a dispute row exists for it. The durable
   * record carries no explicit "ops touched this run" flag; a disputed
   * settlement is the only mode that requires human ops action, so disputes
   * plus ops-settle records are the intervention signal for ADR-0013's "zero
   * ops intervention".
   */
  opsIntervention: boolean;
}

export interface OpsGateMetricResult {
  threshold: number;
  pass: boolean;
}

export interface OpsHealthResult {
  consecutiveQualifyingWeeks: number;
  completedRuns: number;
  disputeRateBps: number;
  zeroTouchRateBps: number;
  repeatBuyers: number;
  gate: {
    qualifyingWeeks: OpsGateMetricResult;
    completedRuns: OpsGateMetricResult;
    disputeRateBps: OpsGateMetricResult;
    zeroTouchRateBps: OpsGateMetricResult;
    repeatBuyers: OpsGateMetricResult;
    pass: boolean;
  };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
/** 1970-01-01 was a Thursday; shifting by 3 days makes week 0 Monday-aligned. */
const MONDAY_OFFSET_MS = 3 * 24 * 60 * 60 * 1_000;

/** UTC Monday-aligned week index for an epoch-ms timestamp. */
export function weekIndex(closedAt: number): number {
  return Math.floor((closedAt + MONDAY_OFFSET_MS) / WEEK_MS);
}

function rateBps(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part * 10_000) / whole);
}

export function computeOpsHealth(facts: OpsRunFact[]): OpsHealthResult {
  const completedRuns = facts.length;

  let disputed = 0;
  let touched = 0;
  const runsPerBuyer = new Map<string, number>();
  const weeks = new Map<number, { runs: number; disputed: number; touched: number }>();

  for (const fact of facts) {
    if (fact.mode === "disputed") disputed += 1;
    if (fact.opsIntervention) touched += 1;
    runsPerBuyer.set(fact.buyerId, (runsPerBuyer.get(fact.buyerId) ?? 0) + 1);

    const index = weekIndex(fact.closedAt);
    const week = weeks.get(index) ?? { runs: 0, disputed: 0, touched: 0 };
    week.runs += 1;
    if (fact.mode === "disputed") week.disputed += 1;
    if (fact.opsIntervention) week.touched += 1;
    weeks.set(index, week);
  }

  const disputeRateBps = rateBps(disputed, completedRuns);
  const zeroTouchRateBps = rateBps(completedRuns - touched, completedRuns);

  let repeatBuyers = 0;
  for (const runs of runsPerBuyer.values()) {
    if (runs > 1) repeatBuyers += 1;
  }

  const weekQualifies = (week: { runs: number; disputed: number; touched: number }): boolean =>
    week.runs > 0 &&
    rateBps(week.disputed, week.runs) < OPS_GATE_THRESHOLDS.disputeRateBps &&
    rateBps(week.runs - week.touched, week.runs) >= OPS_GATE_THRESHOLDS.zeroTouchRateBps;

  let consecutiveQualifyingWeeks = 0;
  if (weeks.size > 0) {
    let index = Math.max(...weeks.keys());
    for (;;) {
      const week = weeks.get(index);
      // A missing week has no runs: it does not qualify and breaks the streak.
      if (!week || !weekQualifies(week)) break;
      consecutiveQualifyingWeeks += 1;
      index -= 1;
    }
  }

  const gate = {
    qualifyingWeeks: {
      threshold: OPS_GATE_THRESHOLDS.qualifyingWeeks,
      pass: consecutiveQualifyingWeeks >= OPS_GATE_THRESHOLDS.qualifyingWeeks,
    },
    completedRuns: {
      threshold: OPS_GATE_THRESHOLDS.completedRuns,
      pass: completedRuns >= OPS_GATE_THRESHOLDS.completedRuns,
    },
    disputeRateBps: {
      threshold: OPS_GATE_THRESHOLDS.disputeRateBps,
      pass: completedRuns > 0 && disputeRateBps < OPS_GATE_THRESHOLDS.disputeRateBps,
    },
    zeroTouchRateBps: {
      threshold: OPS_GATE_THRESHOLDS.zeroTouchRateBps,
      pass: completedRuns > 0 && zeroTouchRateBps >= OPS_GATE_THRESHOLDS.zeroTouchRateBps,
    },
    repeatBuyers: {
      threshold: OPS_GATE_THRESHOLDS.repeatBuyers,
      pass: repeatBuyers >= OPS_GATE_THRESHOLDS.repeatBuyers,
    },
  };

  return {
    consecutiveQualifyingWeeks,
    completedRuns,
    disputeRateBps,
    zeroTouchRateBps,
    repeatBuyers,
    gate: {
      ...gate,
      pass:
        gate.qualifyingWeeks.pass &&
        gate.completedRuns.pass &&
        gate.disputeRateBps.pass &&
        gate.zeroTouchRateBps.pass &&
        gate.repeatBuyers.pass,
    },
  };
}
