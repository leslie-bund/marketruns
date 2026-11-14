import type { ActiveRun, Run } from "@market-runs/proto";

/** Active discovery contains only pool-available runs and runs already assigned to this caller. */
export function partitionRunnerRuns(runs: ActiveRun[]): { available: ActiveRun[]; claimed: ActiveRun[] } {
  return {
    available: runs.filter((run) => run.status === "unassigned"),
    claimed: runs.filter((run) => run.status !== "unassigned"),
  };
}

/** The single selected run defaults to a claimed run, never an unclaimed one. */
export function preferredRunnerRunId(runs: ActiveRun[]): string | null {
  return partitionRunnerRuns(runs).claimed[0]?.runId ?? null;
}

/** Client-side command gate; the RunDO remains the authoritative atomic gate. */
export function canRunnerMutate(run: Run, participantId: string): boolean {
  if (run.status === "unassigned") return false;
  return run.runnerId === participantId;
}
