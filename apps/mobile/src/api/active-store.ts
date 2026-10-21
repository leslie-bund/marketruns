import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import type { Store } from "@market-runs/proto";

/**
 * The device's active Store (GLOSSARY: a seller's storefront in one market).
 * Registered on the market's DO, cached on-device so the seller's identity
 * (name, exchange point, shop items) survives restarts without auth — the
 * participant seam (ADR-0015) replaces this lookup when real accounts land.
 */

const STORAGE_KEY = "market-runs:active-store";

let cache: Store | null = null;
let loaded = false;
const listeners = new Set<(store: Store | null) => void>();

/** Synchronous read for non-React callers (the wire client). */
export function getActiveStore(): Store | null {
  return cache;
}

export async function loadActiveStore(): Promise<Store | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  cache = raw ? (JSON.parse(raw) as Store) : null;
  loaded = true;
  return cache;
}

export async function setActiveStore(store: Store | null): Promise<void> {
  cache = store;
  loaded = true;
  if (store) await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(store)).catch(() => undefined);
  else await AsyncStorage.removeItem(STORAGE_KEY).catch(() => undefined);
  for (const listener of listeners) listener(store);
}

/** Reactive read for screens: the store, plus whether the first load landed. */
export function useActiveStore(): { store: Store | null; loading: boolean } {
  const [store, setStore] = useState<Store | null>(cache);
  const [loading, setLoading] = useState(!loaded);

  useEffect(() => {
    void loadActiveStore().then((next) => {
      setStore(next);
      setLoading(false);
    });
    const listener = (next: Store | null) => setStore(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return { store, loading };
}
