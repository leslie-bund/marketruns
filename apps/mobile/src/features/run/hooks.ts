import { useEffect } from "react";
import type { Run, Store } from "@market-runs/proto";
import { getRun, identities, listActiveRuns, useActiveCartIds } from "../../api";
import { useLiveEvents, usePoll } from "../../api";

export interface RunFollow {
  run: Run | null;
  error: string | null;
  live: boolean;
  refresh: () => void;
}

/** Follow one edge-issued run id: WebSocket fast path, slow polling as the fallback. */
function useRunById(runId: string | null, intervalMs: number): RunFollow {
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
export function useRun(intervalMs = 15000): RunFollow {
  const { runId } = useActiveCartIds();
  return useRunById(runId, intervalMs);
}

/**
 * The runner's live run. The device's own stored run id always wins; when it
 * has none (a runner device that never performed the checkout), discovery
 * polls the live_runs index via the edge (`GET /markets/:market/runs/active`)
 * and follows the most recent live run assigned to this runner. At MVP every
 * run is assigned to runner:internal (ADR-0013), so an internal-runner device
 * sees every live run in the market. An empty discovery result is the
 * existing empty state — the index degrades, it never breaks the screen.
 */
export function useRunnerRun(intervalMs = 15000): RunFollow {
  const { runId: storedRunId } = useActiveCartIds();
  const discovery = usePoll(
    () => (storedRunId ? Promise.resolve(null) : listActiveRuns()),
    intervalMs,
  );
  const discoveredRunId = storedRunId ? null : (discovery.data?.runs[0]?.runId ?? null);
  return useRunById(storedRunId ?? discoveredRunId, intervalMs);
}

/**
 * The seller's live run: the trip carrying this store's products. Same shape
 * as the runner's — the device's own stored run id wins; when it has none (a
 * seller device never performs the checkout), discovery polls the live_runs
 * index via the edge (`GET /markets/:market/runs/active?storeId=…`) and
 * follows the most recent live run containing this store. The store's wire
 * identity is its trading name (products carry sellerName; the demo identity
 * is the fallback before this device joins the market). An empty discovery
 * result is the existing empty state — the index degrades, it never breaks
 * the screen.
 */
export function useSellerRun(store: Store | null, intervalMs = 15000): RunFollow {
  const { runId: storedRunId } = useActiveCartIds();
  const storeName = store?.name ?? identities.seller.name;
  const discovery = usePoll(
    () => (storedRunId ? Promise.resolve(null) : listActiveRuns({ storeId: storeName })),
    intervalMs,
  );
  const discoveredRunId = storedRunId ? null : (discovery.data?.runs[0]?.runId ?? null);
  return useRunById(storedRunId ?? discoveredRunId, intervalMs);
}
