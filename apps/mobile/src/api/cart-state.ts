import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { useActiveMarket } from "./active-market";
import { clearCheckoutPaymentState } from "./payment-state";

/**
 * The device's edge-issued cart/run ids, per market. The edge is authoritative
 * for ids (carts are per buyer: `cart:<market>:<buyerId>`, the run 1:1 with its
 * cart) — the app NEVER derives them. It learns the cart id from the accept
 * response (`cart.updated.cart.id`) or from `GET /markets/:market/cart`, and
 * the run id from `checkout.accepted.runId`, then stores them here so they
 * survive restarts and so the runner/seller surfaces on this device follow
 * the same run. Follows the active-market/active-store cache pattern.
 */

const STORAGE_KEY = "market-runs:cart-state";

interface MarketCartState {
  cartId?: string;
  runId?: string;
}
type CartStateMap = Record<string, MarketCartState>;

let cache: CartStateMap = {};
let loaded = false;
const listeners = new Set<() => void>();

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  cache = raw ? (JSON.parse(raw) as CartStateMap) : {};
  loaded = true;
}

/** Synchronous reads for non-React callers (the wire client). */
export function getStoredCartId(market: string): string | null {
  return cache[market]?.cartId ?? null;
}

export function getStoredRunId(market: string): string | null {
  return cache[market]?.runId ?? null;
}

async function mutate(market: string, change: (state: MarketCartState) => void): Promise<void> {
  await ensureLoaded();
  const next: MarketCartState = { ...cache[market] };
  change(next);
  cache = { ...cache, [market]: next };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache)).catch(() => undefined);
  for (const listener of listeners) listener();
}

/** An accept (or the header-keyed cart re-discovery) told us the cart id. */
export async function recordCartId(market: string, cartId: string): Promise<void> {
  await mutate(market, (state) => {
    state.cartId = cartId;
  });
}

/** The cart is gone (404 on re-discovery, or deadline expiry) — drop it. */
export async function clearCartId(market: string): Promise<void> {
  await mutate(market, (state) => {
    delete state.cartId;
  });
}

/** Checkout landed: remember the run; the cart retired with it. */
export async function recordRunId(market: string, runId: string): Promise<void> {
  await mutate(market, (state) => {
    state.runId = runId;
    delete state.cartId;
  });
}

/** The run retired — the edge deleted its storage, so we forget it too. */
export async function clearRunId(market: string): Promise<void> {
  await mutate(market, (state) => {
    delete state.runId;
  });
}

/** Dev identity reset: the stored ids belong to the previous participant. */
export async function clearCartState(): Promise<void> {
  cache = {};
  loaded = true;
  await Promise.all([
    AsyncStorage.removeItem(STORAGE_KEY).catch(() => undefined),
    clearCheckoutPaymentState(),
  ]);
  for (const listener of listeners) listener();
}

/** Reactive read for screens and hooks, following the device's active market. */
export function useActiveCartIds(): { cartId: string | null; runId: string | null; loading: boolean } {
  const market = useActiveMarket();
  const [ready, setReady] = useState(loaded);
  const [, setTick] = useState(0);

  useEffect(() => {
    void ensureLoaded().then(() => {
      setReady(true);
      setTick((tick) => tick + 1);
    });
    const listener = () => setTick((tick) => tick + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return { cartId: getStoredCartId(market), runId: getStoredRunId(market), loading: !ready };
}
