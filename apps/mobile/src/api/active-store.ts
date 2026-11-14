import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import type { Store } from "@market-runs/proto";
import { getActiveMarket, useActiveMarket } from "./active-market";
import { getActiveParticipant, useActiveParticipant } from "./participant";

/** Stores are participant+market scoped account data. */
const STORAGE_KEY = "market-runs:active-store";
const ownerId = () => getActiveParticipant()?.id ?? "";
const storageKey = (owner: string, market: string) => `${STORAGE_KEY}:${encodeURIComponent(owner)}:${encodeURIComponent(market)}`;
const scopeId = (owner: string, market: string) => `${owner}\u0000${market}`;

function inScope(store: Store | null, owner: string, market: string): store is Store {
  return Boolean(store && store.market === market && store.sellerParticipantId === owner);
}

let cache: Store | null = null;
let cacheOwner: string | null = null;
let loadedScope: string | null = null;
const listeners = new Set<(store: Store | null) => void>();

export function getActiveStore(): Store | null {
  const owner = ownerId();
  return cacheOwner === owner && inScope(cache, owner, getActiveMarket()) ? cache : null;
}

export async function loadActiveStore(): Promise<Store | null> {
  const owner = ownerId();
  const market = getActiveMarket();
  const stored = owner ? await AsyncStorage.getItem(storageKey(owner, market)).catch(() => null) : null;
  const parsed = stored ? JSON.parse(stored) as Store : null;
  cache = inScope(parsed, owner, market) ? parsed : null;
  cacheOwner = owner;
  loadedScope = scopeId(owner, market);
  return cache;
}

export async function setActiveStore(store: Store | null): Promise<void> {
  const owner = ownerId();
  const market = getActiveMarket();
  if (store && !inScope(store, owner, market)) throw new Error("Active store does not belong to this participant and market.");
  cache = store;
  cacheOwner = owner;
  loadedScope = scopeId(owner, market);
  if (store) await AsyncStorage.setItem(storageKey(owner, market), JSON.stringify(store)).catch(() => undefined);
  else if (owner) await AsyncStorage.removeItem(storageKey(owner, market)).catch(() => undefined);
  for (const listener of listeners) listener(store);
}

export function useActiveStore(): { store: Store | null; loading: boolean } {
  const market = useActiveMarket();
  const { participant, loading: participantLoading } = useActiveParticipant();
  const owner = participant?.id ?? "";
  const scope = scopeId(owner, market);
  const [store, setStore] = useState<Store | null>(getActiveStore());
  const [loading, setLoading] = useState(loadedScope !== scope);

  useEffect(() => {
    if (participantLoading) return;
    setLoading(true);
    setStore(getActiveStore());
    void loadActiveStore().then((next) => {
      setStore(next);
      setLoading(false);
    });
    const listener = (next: Store | null) => {
      if (inScope(next, owner, market) || next === null) setStore(next);
    };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, [market, owner, participantLoading]);

  return {
    store: !participantLoading && inScope(store, owner, market) ? store : null,
    loading: participantLoading || loading || loadedScope !== scope,
  };
}
