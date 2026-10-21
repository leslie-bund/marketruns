import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { DEFAULT_MARKET } from "./config";

/**
 * The market this device is trading in (GLOSSARY: Market — a named zone).
 * Participants join markets from the zone list; the active selection drives
 * every scoped read and command (cart and run ids derive from it).
 */

const STORAGE_KEY = "market-runs:active-market";

let cache: string | null = null;
let loaded = false;
const listeners = new Set<(market: string) => void>();

export function getActiveMarket(): string {
  return cache ?? DEFAULT_MARKET;
}

export async function setActiveMarket(market: string): Promise<void> {
  cache = market;
  loaded = true;
  await AsyncStorage.setItem(STORAGE_KEY, market).catch(() => undefined);
  for (const listener of listeners) listener(market);
}

export function useActiveMarket(): string {
  const [market, setMarket] = useState(getActiveMarket());

  useEffect(() => {
    if (!loaded) {
      void AsyncStorage.getItem(STORAGE_KEY)
        .then((raw) => {
          loaded = true;
          if (raw) {
            cache = raw;
            setMarket(raw);
          }
        })
        .catch(() => undefined);
    }
    const listener = (next: string) => setMarket(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return market;
}
