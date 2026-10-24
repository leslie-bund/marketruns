import type { MarketRegistryUpsert, Participant, Store } from "@market-runs/proto";

export interface MarketRecord extends MarketRegistryUpsert {}

export interface PresenceRecord {
  marketId: string;
  participantId: string;
  storeId: string;
  lastSeenAt: number;
}

/** Durable core registry; presence is a deduped, expiring read model. */
export interface CoreRegistry {
  listMarkets(now?: number): Promise<Array<MarketRecord & { onlineSellers: number }>>;
  upsertMarket(market: MarketRegistryUpsert): Promise<void>;
  participant(participantId: string): Promise<Participant | null>;
  saveParticipant(participant: Participant): Promise<void>;
  store(storeId: string): Promise<Store | null>;
  saveStore(store: Store): Promise<void>;
  isInternalRunner(marketId: string, participantId: string): Promise<boolean>;
  joinInternalRunner(marketId: string, participantId: string): Promise<void>;
  heartbeat(presence: PresenceRecord): Promise<void>;
}
