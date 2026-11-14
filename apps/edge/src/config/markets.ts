import type { Env } from "./env.js";
import type { MarketConfig } from "../do/schemas.js";
import { coreRegistry } from "../registry/index.js";

/** Durable market registry. Runtime configuration remains in MarketDO, never in this list cache. */
export const SEED_MARKETS: ReadonlyArray<{ id: string }> = [{ id: "Balogun" }, { id: "Computer Village" }];

export async function listMarketIds(env: Env): Promise<string[]> {
  return (await coreRegistry(env).listMarkets()).map((market) => market.id);
}

export function isKnownMarket(ids: string[], name: string): boolean {
  const wanted = name.toLowerCase();
  return ids.some((id) => id.toLowerCase() === wanted);
}

/** CRUD-ready create compatibility for the existing ops route. */
export async function addMarketToIndex(env: Env, name: string, config?: MarketConfig): Promise<boolean> {
  try {
    await coreRegistry(env).upsertMarket({
      id: name, name, opensAt: "08:00", closesAt: "18:00",
      ...(config?.geo ? { geofence: { center: config.geo.center, radiusMeters: config.geo.radiusMeters } } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

/** Persist the enforcement center/radius without replacing the market's schedule. */
export async function syncMarketGeofence(env: Env, name: string, config: MarketConfig): Promise<void> {
  const registry = coreRegistry(env);
  const existing = (await registry.listMarkets()).find((market) => market.id.toLowerCase() === name.toLowerCase());
  if (!existing) throw new Error(`market ${name} is not registered`);
  await registry.upsertMarket({
    id: existing.id, name: existing.name, opensAt: existing.opensAt, closesAt: existing.closesAt,
    ...(config.geo ? { geofence: { center: config.geo.center, radiusMeters: config.geo.radiusMeters } } : {}),
  });
}
