/**
 * Computed-metrics reputation (GLOSSARY.md, ADR-0013): a participant's
 * standing derived ONLY from the durable record — completed trips, abort
 * rates, and dispute outcomes. Never user-entered ratings; no stars, no
 * reviews. The function is pure over ReputationFact rows so the archive
 * consumer can feed it straight from Postgres (runs_archive +
 * settlement_records.inputs + disputes).
 */

export type ReputationRole = "buyer" | "runner" | "seller";

export type SettlementOutcomeMode = "completed" | "aborted" | "disputed";

/** One run's contribution to a participant's standing, as recorded at close. */
export interface ReputationFact {
  runId: string;
  mode: SettlementOutcomeMode;
  role: ReputationRole;
  /**
   * Seller role only: whether this participant's stop completed. A seller
   * whose stop failed is paid nothing and takes a reputation strike
   * (ADR-0008).
   */
  stopCompleted?: boolean;
  /** A dispute whose evidence found this participant at fault (ADR-0007). */
  faulted?: boolean;
}

export interface Reputation {
  participantId: string;
  completedTrips: number;
  abortedTrips: number;
  disputedTrips: number;
  /** Failed seller stops plus disputes lost. */
  strikes: number;
  /** aborted / (completed + aborted + disputed), basis points; 0 with no history. */
  abortRateBps: number;
  /**
   * Composite standing in basis points, 0–10 000. Start at 10 000; each
   * abort costs 2 000, each strike 1 500; floored at 0. The formula is
   * deliberately simple and fully deterministic — it is a gate signal, not a
   * ranking.
   */
  standingBps: number;
}

const STANDING_FULL_BPS = 10_000;
const ABORT_PENALTY_BPS = 2_000;
const STRIKE_PENALTY_BPS = 1_500;

export function computeReputation(participantId: string, facts: ReputationFact[]): Reputation {
  let completedTrips = 0;
  let abortedTrips = 0;
  let disputedTrips = 0;
  let strikes = 0;

  for (const fact of facts) {
    if (fact.role === "seller" && fact.stopCompleted === false) {
      // A failed stop is a strike in every mode (ADR-0008); a completed run
      // with an incomplete seller stop still owes the seller nothing.
      strikes += 1;
      continue;
    }
    if (fact.mode === "completed") completedTrips += 1;
    else if (fact.mode === "aborted") abortedTrips += 1;
    else disputedTrips += 1;
    if (fact.faulted) strikes += 1;
  }

  const total = completedTrips + abortedTrips + disputedTrips;
  const abortRateBps = total === 0 ? 0 : Math.round((abortedTrips * 10_000) / total);
  const standingBps = Math.max(
    0,
    STANDING_FULL_BPS - ABORT_PENALTY_BPS * abortedTrips - STRIKE_PENALTY_BPS * strikes,
  );

  return { participantId, completedTrips, abortedTrips, disputedTrips, strikes, abortRateBps, standingBps };
}
