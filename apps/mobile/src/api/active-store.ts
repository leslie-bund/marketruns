import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import type { Store } from "@market-runs/proto";
import { getActiveMarket, useActiveMarket } from "./active-market";

/** Stores are market-scoped so a switch never authenticates with another market's storeId. */
const LEGACY_STORAGE_KEY = "market-runs:active-store";
const storageKey = (market: string) => `${LEGACY_STORAGE_KEY}:${market}`;

let cache: Store | null = null;
let loadedMarket: string | null = null;
const listeners = new Set<(store: Store | null) => void>();

export function getActiveStore(): Store | null {
  return cache?.market === getActiveMarket() ? cache : null;
}

export async function loadActiveStore(): Promise<Store | null> {
  const market = getActiveMarket();
  const scoped = await AsyncStorage.getItem(storageKey(market)).catch(() => null);
  const legacy = scoped ? null : await AsyncStorage.getItem(LEGACY_STORAGE_KEY).catch(() => null);
  const parsed = (scoped ?? legacy) ? JSON.parse((scoped ?? legacy)!) as Store : null;
  cache = parsed?.market === market ? parsed : null;
  loadedMarket = market;
  return cache;
}

export async function setActiveStore(store: Store | null): Promise<void> {
  const market = getActiveMarket();
  if (store && store.market !== market) throw new Error("Active store does not belong to the active market.");
  cache = store;
  loadedMarket = market;
  if (store) await AsyncStorage.setItem(storageKey(market), JSON.stringify(store)).catch(() => undefined);
  else await AsyncStorage.removeItem(storageKey(market)).catch(() => undefined);
  for (const listener of listeners) listener(store);
}

export function useActiveStore(): { store: Store | null; loading: boolean } {
  const market = useActiveMarket();
  const [store, setStore] = useState<Store | null>(getActiveStore());
  const [loading, setLoading] = useState(loadedMarket !== market);

  useEffect(() => {
    setLoading(true);
    setStore(getActiveStore());
    void loadActiveStore().then((next) => {
      setStore(next);
      setLoading(false);
    });
    const listener = (next: Store | null) => {
      if (next === null || next.market === market) setStore(next);
    };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, [market]);

  return { store, loading };
}
