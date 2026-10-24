import type { Intent, Product, Store } from "@market-runs/proto";
import { useActiveMarket, useActiveStore } from "../../api";
import { discoverIntentsForItems } from "../../api";
import { useLiveEvents, usePoll } from "../../api";
import { useSellerRun } from "../run";

/**
 * Open demand in the market, scoped to the store's shop items (GLOSSARY: an
 * intent is visible to stores whose shop items match it; the vocabulary is
 * the room — ADR-0006). One filtered discovery call, no fan-out; live over
 * the market's WebSocket on the `intents` topic, so this device only ever
 * hears intent lifecycle events.
 */
export function useOpenIntents(shopItems?: string[] | null, storeId?: string) {
  const market = useActiveMarket();
  const poll = usePoll(async () => {
    if (!shopItems || shopItems.length === 0) return [] as Intent[];
    const entries = await discoverIntentsForItems(shopItems, storeId);
    return entries.map((entry) => entry.intent);
  }, 15000);
  useLiveEvents(
    `/markets/${encodeURIComponent(market)}`,
    () => poll.refresh(),
    () => poll.refresh(),
    ["intents"],
    { ...(storeId ? { storeId } : {}), heartbeat: Boolean(storeId) },
  );
  return poll;
}

/**
 * The store's live products: everything offered across the market by THIS
 * store. These are the store's negotiation threads. One discovery call scoped
 * to the store's shop items (from the active-store cache) returns the matching
 * intents with their products inline — no all-intents fetch, no per-intent
 * lookups.
 */
export function useSellerProducts(storeName: string | undefined, intervalMs = 4000): {
  products: Product[];
  loading: boolean;
  refresh: () => void;
} {
  const { store } = useActiveStore();
  const shopItems = store?.shopItems ?? null;
  const { data, refresh, error } = usePoll(async () => {
    if (!storeName || !shopItems || shopItems.length === 0) return [] as Product[];
    const entries = await discoverIntentsForItems(shopItems, store?.id);
    return entries
      .flatMap((entry) => entry.products)
      .filter(
        (product) =>
          product.sellerName === storeName &&
          // Accepted stays visible: it is the seller's door into the trip
          // carrying their product (view trip → handoff QR).
          (product.status === "available" || product.status === "negotiating" || product.status === "accepted"),
      );
  }, intervalMs);
  void error;
  return { products: data ?? [], loading: data === null, refresh };
}

/**
 * Tab-bar badges for the seller phases: fresh demand in the store's scope,
 * negotiation threads mid-flight, and handoffs at the store's exchange point
 * waiting on the QR. The trip badge follows useSellerRun — a seller device
 * never has a stored run id, so discovery over the live_runs index is what
 * finds the run carrying this store's products; the run refreshes instantly
 * over its WebSocket scope.
 */
export function useSellerBadges(store: Store | null): { demand: number; threads: number; trip: number } {
  const intents = useOpenIntents(store?.shopItems ?? null, store?.id);
  const mine = useSellerProducts(store?.name);
  const run = useSellerRun(store);

  const demand = intents.data?.filter((intent) => intent.status === "open").length ?? 0;
  const threads = mine.products.filter((product) => product.status === "negotiating").length;
  const trip =
    run.run?.handoffs.filter(
      (handoff) => handoff.exchangePoint === store?.exchangePoint && handoff.status === "pending",
    ).length ?? 0;
  return { demand, threads, trip };
}
