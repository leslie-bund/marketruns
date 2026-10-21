/**
 * The zone registry (GLOSSARY: Market). Seed zones are always joinable; the
 * KV index (`markets:index` in MARKET_CONFIG) adds every zone a participant
 * has joined or ops has created. Dev-stage home — ADR-0016.
 */

/** Launch seed zones (ADR-0013): always listed, always joinable. */
export const SEED_MARKETS: ReadonlyArray<{ id: string }> = [{ id: "Balogun" }, { id: "Computer Village" }];

/** Every known zone id: seeds first, then the KV index (heals itself on join). */
export async function listMarketIds(kv: KVNamespace): Promise<string[]> {
  const seeds = SEED_MARKETS.map((market) => market.id);
  try {
    const index = (await kv.get("markets:index", "json")) as Array<{ id: string }> | null;
    const extra = (index ?? []).map((entry) => entry.id).filter((id) => !seeds.includes(id));
    return [...seeds, ...extra];
  } catch {
    return seeds;
  }
}

/** Case-insensitive membership check — zone names are display names, not slugs. */
export function isKnownMarket(ids: string[], name: string): boolean {
  const wanted = name.toLowerCase();
  return ids.some((id) => id.toLowerCase() === wanted);
}

/** Add a zone to the KV index (idempotent). Returns false when KV is unavailable. */
export async function addMarketToIndex(kv: KVNamespace, name: string): Promise<boolean> {
  try {
    const current = (await kv.get("markets:index", "json")) as Array<{ id: string }> | null;
    const index = current ?? [];
    if (!index.some((entry) => entry.id === name)) {
      index.push({ id: name });
      await kv.put("markets:index", JSON.stringify(index));
    }
    return true;
  } catch {
    return false;
  }
}
