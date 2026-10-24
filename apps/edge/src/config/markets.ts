import type { Env } from "./env.js";
import { coreRegistry } from "../registry/index.js";

/** Durable market registry. Runtime configuration remains in MarketDO/KV, never in this list cache. */
export const SEED_MARKETS: ReadonlyArray<{ id: string }> = [{ id: "Balogun" }, { id: "Computer Village" }];

export async function listMarketIds(env: Env): Promise<string[]> {
  return (await coreRegistry(env).listMarkets()).map((market) => market.id);
}

export function isKnownMarket(ids: string[], name: string): boolean {
  const wanted = name.toLowerCase();
  return ids.some((id) => id.toLowerCase() === wanted);
}

/** CRUD-ready create compatibility for the existing ops route. */
export async function addMarketToIndex(env: Env, name: string): Promise<boolean> {
  try {
    await coreRegistry(env).upsertMarket({ id: name, name, opensAt: "08:00", closesAt: "18:00" });
    return true;
  } catch {
    return false;
  }
}
