import { useEffect, useState } from "react";
import type { Intent, Product } from "@market-runs/proto";
import { buyerIdForRun, discoverMyIntents, getCart, getRun, useActiveCartIds, useActiveMarket } from "../../api";
import { useLiveEvents, usePoll } from "../../api";

/**
 * The buyer's own intents, polled — the discovery read scoped by the caller's
 * identity headers (buyers only ask for what they typed), with each intent's
 * products inlined server-side. Live over the market's WebSocket on this
 * buyer's `intent:<id>` topics, so nothing market-wide reaches this device.
 */
export function useMyIntents() {
  const market = useActiveMarket();
  const poll = usePoll(async () => (await discoverMyIntents()).map((entry) => entry.intent), 4000);
  const topics = (poll.data ?? []).map((intent) => `intent:${intent.id}`);
  useLiveEvents(`/markets/${encodeURIComponent(market)}`, () => poll.refresh(), () => poll.refresh(), topics);
  return poll;
}

/**
 * Every live product offered against any of the buyer's intents — the
 * "Products responding" view. One scoped discovery call returns the buyer's
 * intents with their products inline (no per-intent fan-out); refreshes on a
 * slower cadence and dedupes by product id (an intent can attract several
 * offers). The `intents` argument stays as the readiness gate.
 */
export function useBuyerProducts(intents: Intent[] | null, intervalMs = 5000): {
  products: Product[];
  loading: boolean;
  refresh: () => void;
} {
  const [products, setProducts] = useState<Product[]>([]);
  const { refresh, data } = usePoll(async () => {
    if (!intents || intents.length === 0) return [] as Product[];
    const entries = await discoverMyIntents();
    const seen = new Map<string, Product>();
    for (const entry of entries) {
      for (const product of entry.products) {
        if (product.status === "available" || product.status === "negotiating") seen.set(product.id, product);
      }
    }
    return [...seen.values()];
  }, intervalMs);

  useEffect(() => {
    if (data) setProducts(data);
  }, [data]);

  return { products, loading: intents !== null && data === null, refresh };
}

/**
 * Tab-bar badges for the buyer phases: live offers to review, cart items
 * awaiting checkout, and a run demanding attention (the delivery QR is up).
 * Cart and run refresh instantly over their WebSocket scopes — subscribed
 * with the edge-issued ids from the device cart state.
 */
export function useBuyerBadges(): { offers: number; cart: number; track: number } {
  const { cartId, runId } = useActiveCartIds();
  const intents = useMyIntents();
  const products = useBuyerProducts(intents.data);
  const cart = usePoll(getCart, 15000);
  const run = usePoll(() => (runId ? getRun(runId) : Promise.resolve(null)), 15000);
  useLiveEvents(cartId ? `/carts/${encodeURIComponent(cartId)}` : null, () => cart.refresh(), () => cart.refresh(), cartId ? [`cart:${cartId}`] : undefined);
  useLiveEvents(runId ? `/runs/${encodeURIComponent(runId)}` : null, () => run.refresh(), () => run.refresh(), runId ? [`run:${runId}`] : undefined);
  // Freshly recorded ids (accept/checkout just landed) refresh immediately.
  useEffect(() => {
    if (cartId) cart.refresh();
  }, [cartId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (runId) run.refresh();
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const cartCount = cart.data && cart.data.status === "open" ? cart.data.products.length : 0;
  const buyer = run.data ? buyerIdForRun(run.data) : null;
  const awaitingReceipt = run.data?.handoffs.some((handoff) => handoff.counterparty === buyer && handoff.status === "pending") ?? false;
  return { offers: products.products.length, cart: cartCount, track: awaitingReceipt ? 1 : 0 };
}
