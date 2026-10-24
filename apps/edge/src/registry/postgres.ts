import postgres from "postgres";
import type { Participant, Store } from "@market-runs/proto";
import { PRESENCE_TTL_MS } from "@market-runs/proto";
import type { CoreRegistry, MarketRecord, PresenceRecord } from "./types.js";

type Sql = ReturnType<typeof postgres>;
const millis = (value: unknown) => value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
const date = (value: number | undefined) => value === undefined ? null : new Date(value);

/** Neon/Hyperdrive adapter. Raw SQL keeps the worker's registry contract small and explicit. */
export class PostgresCoreRegistry implements CoreRegistry {
  constructor(private readonly sql: Sql) {}

  async listMarkets(now = Date.now()) {
    const rows = await this.sql`
      SELECT m.id, m.name, m.opens_at::text AS "opensAt", m.closes_at::text AS "closesAt",
        COUNT(DISTINCT p.participant_id)::int AS "onlineSellers"
      FROM markets m
      LEFT JOIN seller_presence p ON p.market_id = m.id AND p.last_seen_at > ${new Date(now - PRESENCE_TTL_MS)}
      GROUP BY m.id, m.name, m.opens_at, m.closes_at
      ORDER BY m.name`;
    return rows as unknown as Array<MarketRecord & { onlineSellers: number }>;
  }

  async upsertMarket(market: MarketRecord) {
    await this.sql`
      INSERT INTO markets (id, name, opens_at, closes_at)
      VALUES (${market.id}, ${market.name}, ${market.opensAt}, ${market.closesAt})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, opens_at = EXCLUDED.opens_at,
        closes_at = EXCLUDED.closes_at, updated_at = now()`;
  }

  async participant(participantId: string): Promise<Participant | null> {
    const rows = await this.sql`SELECT * FROM participant_profiles WHERE participant_id = ${participantId} LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.participant_id,
      role: row.role,
      displayName: row.display_name,
      ...(row.email ? { email: row.email } : {}),
      ...(row.verified_legal_name ? { verifiedLegalName: row.verified_legal_name } : {}),
      kycStatus: row.kyc_status,
      idDocumentType: row.id_document_type,
      idDocumentHash: row.id_document_hash,
      ...(row.consent_at ? { consentAt: millis(row.consent_at) } : {}),
      ...(row.consent_version ? { consentVersion: row.consent_version } : {}),
      ...(row.facial_capture_ref ? { facialCaptureRef: row.facial_capture_ref } : {}),
      markets: row.markets,
      createdAt: millis(row.created_at),
    } as Participant;
  }

  async saveParticipant(participant: Participant) {
    await this.sql`
      INSERT INTO participant_profiles (
        participant_id, role, email, display_name, verified_legal_name, kyc_status,
        id_document_type, id_document_hash, facial_capture_ref, consent_at, consent_version, markets
      ) VALUES (
        ${participant.id}, ${participant.role}, ${participant.email ?? null}, ${participant.displayName},
        ${participant.verifiedLegalName ?? null}, ${participant.kycStatus}, ${participant.idDocumentType},
        ${participant.idDocumentHash}, ${participant.facialCaptureRef ?? null}, ${date(participant.consentAt)},
        ${participant.consentVersion ?? null}, ${this.sql.json(participant.markets)}
      )
      ON CONFLICT (participant_id) DO UPDATE SET
        role = EXCLUDED.role, email = EXCLUDED.email, display_name = EXCLUDED.display_name,
        verified_legal_name = EXCLUDED.verified_legal_name, kyc_status = EXCLUDED.kyc_status,
        id_document_type = EXCLUDED.id_document_type, id_document_hash = EXCLUDED.id_document_hash,
        facial_capture_ref = EXCLUDED.facial_capture_ref, consent_at = EXCLUDED.consent_at,
        consent_version = EXCLUDED.consent_version, markets = EXCLUDED.markets, updated_at = now()`;
  }

  async store(storeId: string): Promise<Store | null> {
    const rows = await this.sql`SELECT * FROM stores WHERE id = ${storeId} LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      market: row.market_id,
      name: row.name,
      sellerParticipantId: row.seller_id,
      exchangePoint: row.exchange_point,
      shopItems: row.shop_items,
      joinedAt: millis(row.joined_at),
    } as Store;
  }

  async saveStore(store: Store) {
    if (!store.sellerParticipantId) throw new Error("store sellerParticipantId is required");
    await this.sql`
      INSERT INTO stores (id, seller_id, market_id, name, exchange_point, shop_items, joined_at)
      VALUES (${store.id}, ${store.sellerParticipantId}, ${store.market}, ${store.name}, ${store.exchangePoint},
        ${this.sql.json(store.shopItems)}, ${new Date(store.joinedAt)})
      ON CONFLICT (id) DO UPDATE SET seller_id = EXCLUDED.seller_id,
        market_id = EXCLUDED.market_id, name = EXCLUDED.name, exchange_point = EXCLUDED.exchange_point,
        shop_items = EXCLUDED.shop_items, updated_at = now()`;
  }

  async isInternalRunner(marketId: string, participantId: string) {
    const rows = await this.sql`
      SELECT 1 FROM runner_pool_memberships membership
      JOIN runner_pools pool ON pool.id = membership.pool_id
      WHERE pool.market_id = ${marketId} AND membership.runner_id = ${participantId}
        AND pool.active = true AND membership.active = true
      LIMIT 1`;
    return rows.length > 0;
  }

  async joinInternalRunner(marketId: string, participantId: string) {
    const poolId = `pool:${marketId}`;
    await this.sql`
      INSERT INTO runner_pools (id, market_id, name) VALUES (${poolId}, ${marketId}, ${`${marketId} Internal Runners`})
      ON CONFLICT (id) DO NOTHING`;
    await this.sql`
      INSERT INTO runner_pool_memberships (pool_id, runner_id) VALUES (${poolId}, ${participantId})
      ON CONFLICT (pool_id, runner_id) DO UPDATE SET active = true, updated_at = now()`;
  }

  async heartbeat(presence: PresenceRecord) {
    await this.sql`
      INSERT INTO seller_presence (market_id, participant_id, store_id, last_seen_at)
      VALUES (${presence.marketId}, ${presence.participantId}, ${presence.storeId}, ${new Date(presence.lastSeenAt)})
      ON CONFLICT (market_id, participant_id) DO UPDATE SET store_id = EXCLUDED.store_id, last_seen_at = EXCLUDED.last_seen_at`;
  }
}
