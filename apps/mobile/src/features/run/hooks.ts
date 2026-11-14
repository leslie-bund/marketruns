import { useEffect, useState } from "react";
import type { ActiveRun, Run, Store } from "@market-runs/proto";
import { getRun, listActiveRuns, useActiveCartIds } from "../../api";
import { useLiveEvents, usePoll } from "../../api";
import { partitionRunnerRuns, preferredRunnerRunId } from "./runner-state";

export interface RunFollow {
  run: Run | null;
  error: string | null;
  live: boolean;
  refresh: () => void;
}

/** Follow one edge-issued run id: WebSocket fast path, slow polling as the fallback. */
export function useRunById(runId: string | null, intervalMs: number): RunFollow {
  const { data, error, refresh } = usePoll(() => (runId ? getRun(runId) : Promise.resolve(null)), intervalMs);
  const live = useLiveEvents(runId ? `/runs/${encodeURIComponent(runId)}` : null, () => refresh(), () => refresh());
  // A freshly learned run id (checkout just landed, or discovery found one) fetches immediately.
  useEffect(() => {
    if (runId) refresh();
  }, [runId, refresh]);
  return { run: data, error, live, refresh };
}

/**
 * The device's live run — shared by every role (buyer tracks it, the runner
 * works it, the seller watches their pickup). The run id is the edge-issued
 * one from checkout.accepted, kept in the device cart state; with no stored
 * id there is nothing to follow (a run this device never saw is not
 * discoverable on the wire — buyers always saw their own checkout). Live
 * events arrive over the run's WebSocket; slow polling is the fallback.
 * Follows the device's active market.
 */
export function useRun(intervalMs = 15000, routeRunId?: string): RunFollow {
  const { runId: storedRunId } = useActiveCartIds();
  const discovery = usePoll(
    () => (routeRunId || storedRunId ? Promise.resolve(null) : listActiveRuns({ buyer: true })),
    intervalMs,
  );
  const discoveredRunId = discovery.data?.runs[0]?.runId ?? null;
  return useRunById(routeRunId ?? storedRunId ?? discoveredRunId, intervalMs);
}

export interface RunnerPoolFollow extends RunFollow {
  available: ActiveRun[];
  claimed: ActiveRun[];
  warning: string | null;
  discoveryError: string | null;
  refreshDiscovery: () => void;
  selectRun: (runId: string) => void;
}

/** Internal-pool queue plus the runner's claimed work; unassigned runs never auto-open. */
export function useRunnerPool(intervalMs = 8000, routeRunId?: string): RunnerPoolFollow {
  const discovery = usePoll(listActiveRuns, intervalMs);
  const [chosenRunId, setChosenRunId] = useState<string | null>(null);
  const runs = discovery.data?.runs ?? [];
  const { available, claimed } = partitionRunnerRuns(runs);
  const selectedRunId = routeRunId ?? chosenRunId ?? preferredRunnerRunId(runs);
  const follow = useRunById(selectedRunId, intervalMs);

  useEffect(() => {
    if (chosenRunId && discovery.data && !runs.some((run) => run.runId === chosenRunId)) {
      setChosenRunId(null);
    }
  }, [discovery.data, chosenRunId]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    ...follow,
    available,
    claimed,
    warning: discovery.data?.warning ?? null,
    discoveryError: discovery.error,
    refreshDiscovery: discovery.refresh,
    selectRun: setChosenRunId,
  };
}

/** Follow a claimed run on detail screens; an explicit route id wins over rediscovery. */
export function useRunnerRun(intervalMs = 15000, routeRunId?: string): RunFollow {
  const { runId: storedRunId } = useActiveCartIds();
  const discovery = usePoll(
    () => (routeRunId || storedRunId ? Promise.resolve(null) : listActiveRuns()),
    intervalMs,
  );
  const discoveredRunId = preferredRunnerRunId(discovery.data?.runs ?? []);
  return useRunById(routeRunId ?? storedRunId ?? discoveredRunId, intervalMs);
}

/** Follow a selected live trip containing this owned store; deep-link ids win. */
export function useSellerRun(store: Store | null, intervalMs = 15000, routeRunId?: string): RunFollow & { runs: ActiveRun[]; selectRun: (runId: string) => void } {
  const storeId = store?.id ?? "";
  const [chosenRunId, setChosenRunId] = useState<string | null>(null);
  const discovery = usePoll(
    () => storeId ? listActiveRuns({ storeId }).catch(() => ({ runs: [], warning: "Live run discovery is unavailable." })) : Promise.resolve({ runs: [] }),
    intervalMs,
  );
  const runs = discovery.data?.runs ?? [];
  const selectedRunId = routeRunId ?? chosenRunId ?? runs[0]?.runId ?? null;
  return { ...useRunById(selectedRunId, intervalMs), runs, selectRun: setChosenRunId };
}
