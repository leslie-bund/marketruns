import type { Participant, Store } from "@market-runs/proto";
import { PRESENCE_TTL_MS } from "@market-runs/proto";
import type { CoreRegistry, MarketRecord, PresenceRecord } from "./types.js";

const SEEDS: MarketRecord[] = [
  { id: "Balogun", name: "Balogun", opensAt: "08:00", closesAt: "18:00", geofence: { center: { latitude: 6.4541, longitude: 3.3947 }, radiusMeters: 750 } },
  { id: "Computer Village", name: "Computer Village", opensAt: "08:00", closesAt: "19:00", geofence: { center: { latitude: 6.5186, longitude: 3.375 }, radiusMeters: 750 } },
];

interface MemoryState {
  markets: Map<string, MarketRecord>;
  participants: Map<string, Participant>;
  stores: Map<string, Store>;
  runners: Set<string>;
  presence: Map<string, PresenceRecord>;
}

const key = Symbol.for("market-runs.core-registry.memory.v1");
const globalRegistry = globalThis as typeof globalThis & { [key]?: MemoryState };
const state: MemoryState = globalRegistry[key] ??= {
  markets: new Map(SEEDS.map((market) => [market.id, market])),
  participants: new Map(),
  stores: new Map(),
  runners: new Set(),
  presence: new Map(),
};

const runnerKey = (marketId: string, participantId: string) => `${marketId}\u0000${participantId}`;
const presenceKey = (marketId: string, participantId: string) => `${marketId}\u0000${participantId}`;

/** Explicit dev/test adapter. It is never selected in the deployed default posture. */
export class MemoryCoreRegistry implements CoreRegistry {
  async listMarkets(now = Date.now()) {
    return [...state.markets.values()].map((market) => ({
      ...market,
      onlineSellers: new Set(
        [...state.presence.values()]
          .filter((entry) => entry.marketId === market.id && now - entry.lastSeenAt <= PRESENCE_TTL_MS && now - entry.location.observedAt <= 60_000)
          .map((entry) => entry.participantId),
      ).size,
    }));
  }

  async upsertMarket(market: MarketRecord) {
    state.markets.set(market.id, { ...market });
  }

  async participant(participantId: string) {
    const value = state.participants.get(participantId);
    return value ? structuredClone(value) : null;
  }

  async saveParticipant(participant: Participant) {
    state.participants.set(participant.id, structuredClone(participant));
  }

  async store(storeId: string) {
    const value = state.stores.get(storeId);
    return value ? structuredClone(value) : null;
  }

  async saveStore(store: Store) {
    state.stores.set(store.id, structuredClone(store));
  }

  async isInternalRunner(marketId: string, participantId: string) {
    return state.runners.has(runnerKey(marketId, participantId));
  }

  async joinInternalRunner(marketId: string, participantId: string) {
    state.runners.add(runnerKey(marketId, participantId));
  }

  async heartbeat(presence: PresenceRecord) {
    state.presence.set(presenceKey(presence.marketId, presence.participantId), structuredClone(presence));
  }

  async removePresence(marketId: string, participantId: string, storeId: string) {
    const key = presenceKey(marketId, participantId);
    if (state.presence.get(key)?.storeId === storeId) state.presence.delete(key);
  }
}
