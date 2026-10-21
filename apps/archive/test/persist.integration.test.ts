import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeReputation } from "@market-runs/domain";
import { resolveIntegrationDatabase } from "@market-runs/test-db";
import {
  archivedProducts,
  ledgerEntries,
  liveRuns,
  runsArchive,
  settlementRecords,
} from "../../../infra/drizzle/schema.js";
import { listAdminRuns } from "../src/admin.js";
import { createDatabase } from "../src/db.js";
import consumer from "../src/index.js";
import { loadReputation } from "../src/reputation.js";

/**
 * Functional integration test for the archive pipeline — first-class: it runs
 * by default against the dedicated `market_runs_test` database in the dev
 * Postgres container (localhost:54322), created and migrated on first use, and
 * fails with an actionable message when the database is unreachable. It never
 * touches `market_runs`, where live-session settlement/ledger evidence lives —
 * this suite TRUNCATEs its five tables. Set ARCHIVE_TEST_DATABASE_URL to point
 * at a different database. The durable record is asserted for real: queue batch
 * → consumer → Postgres rows → reputation.
 */
let url: string;
beforeAll(async () => {
  url = await resolveIntegrationDatabase({ envVar: "ARCHIVE_TEST_DATABASE_URL" });
}, 6 * 60_000);

describe("archive consumer against real Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  beforeAll(async () => {
    sql = postgres(url, { max: 1, prepare: false });
    db = drizzle(sql);
    // Hermetic start: a crashed prior run must not leak rows into the
    // unfiltered assertions below (the suite still truncates on exit too).
    await sql`TRUNCATE runs_archive, settlement_records, archived_products, ledger_entries, live_runs CASCADE`;
  });
  afterAll(async () => {
    await sql`TRUNCATE runs_archive, settlement_records, archived_products, ledger_entries, live_runs CASCADE`;
    await sql.end();
  });

  const now = Date.now();
  const batch = [
    {
      id: "m-1",
      body: JSON.stringify({
        type: "run.retired",
        runId: "itest-run-1",
        cartId: "itest-cart-1",
        market: "Balogun",
        buyerId: "itest-buyer",
        runnerId: "runner:internal",
        status: "closed",
        floorRateKobo: 170_000,
        delivery: { kind: "plus-code", plusCode: "6FR5+8X Lagos" },
        stops: [],
        mode: "completed",
        settlementLegs: [{ sellerId: "itest-seller", amountKobo: 165_000 }],
        runnerKobo: 170_000,
        platformKobo: 26_500,
        buyerRefundKobo: 0,
        platformLossKobo: 0,
        closedAt: now,
      }),
      ack: () => undefined,
      retry: () => undefined,
    } as unknown as Message,
    {
      id: "m-2",
      body: JSON.stringify({
        type: "settlement.released",
        runId: "itest-run-1",
        buyerId: "itest-buyer",
        runnerId: "runner:internal",
        mode: "completed",
        sellers: [{ sellerId: "itest-seller", amountKobo: 165_000 }],
        runnerKobo: 170_000,
        platformKobo: 26_500,
        buyerRefundKobo: 0,
        platformLossKobo: 0,
        releasedAt: now,
        inputs: {
          mode: "completed",
          sellers: [{ sellerId: "itest-seller", amountKobo: 165_000, stopCompleted: true }],
          deliveryPriceKobo: 170_000,
          deliveryMarginKobo: 10_000,
          goodsCommissionBps: 1_000,
        },
      }),
      ack: () => undefined,
      retry: () => undefined,
    } as unknown as Message,
    {
      id: "m-3",
      body: JSON.stringify({
        type: "product.retired",
        productId: "itest-product-1",
        intentId: "itest-intent-1",
        reason: "sold",
        retiredAt: now,
        market: "Balogun",
        buyerId: "itest-buyer",
        snapshot: {
          id: "itest-product-1",
          intentId: "itest-intent-1",
          shopItem: "Tomatoes",
          quantity: 2,
          unit: "kg",
          priceKobo: 165_000,
          sellerName: "itest-seller",
          exchangePoint: "Stall B14",
          expiresAt: now,
          status: "retired",
        },
      }),
      ack: () => undefined,
      retry: () => undefined,
    } as unknown as Message,
  ];

  it("persists runs, settlements, ledger legs, and products; redelivery replays", async () => {
    const env = { DATABASE_URL: url };
    await consumer.queue({ messages: batch, queue: "archive-snapshots", retryAll: () => undefined } as unknown as MessageBatch<unknown>, env);
    await consumer.queue({ messages: batch, queue: "archive-snapshots", retryAll: () => undefined } as unknown as MessageBatch<unknown>, env);

    const [run] = await db.select().from(runsArchive).where(eq(runsArchive.id, "itest-run-1"));
    expect(run?.buyerId).toBe("itest-buyer");
    expect(run?.marketId).toBe("Balogun");

    const [settlement] = await db.select().from(settlementRecords).where(eq(settlementRecords.runId, "itest-run-1"));
    expect(settlement?.goodsTotalKobo).toBe(165_000);
    expect(settlement?.platformKobo).toBe(26_500);

    // Double-entry: exactly one balanced set of legs despite the redelivery.
    const legs = await db.select().from(ledgerEntries).where(eq(ledgerEntries.settlementRecordId, "itest-run-1:settlement"));
    expect(legs.length).toBe(4);
    const debited = legs.reduce((sum, leg) => sum + Number(leg.debitKobo), 0);
    const credited = legs.reduce((sum, leg) => sum + Number(leg.creditKobo), 0);
    expect(debited).toBe(credited);
    expect(debited).toBe(361_500);

    const [product] = await db.select().from(archivedProducts).where(eq(archivedProducts.id, "itest-product-1"));
    expect(product?.retirementReason).toBe("accepted");
    expect(product?.storeId).toBe("itest-seller");
  });

  it("persists run.started store_ids and filters /admin/runs by store", async () => {
    const started = (runId: string, storeIds: string[]) =>
      ({
        id: `m-started-${runId}`,
        body: JSON.stringify({
          type: "run.started",
          runId,
          market: "Balogun",
          status: "assigned",
          runnerId: "runner:internal",
          buyerId: "itest-buyer",
          startedAt: now,
          stopCount: storeIds.length,
          storeIds,
        }),
        ack: () => undefined,
        retry: () => undefined,
      }) as unknown as Message;
    const env = { DATABASE_URL: url };
    const batch = [started("itest-live-1", ["itest-seller"]), started("itest-live-2", ["someone-else"])];
    await consumer.queue({ messages: batch, queue: "archive-snapshots", retryAll: () => undefined } as unknown as MessageBatch<unknown>, env);

    const [live] = await db.select().from(liveRuns).where(eq(liveRuns.runId, "itest-live-1"));
    expect(live?.storeIds).toEqual(["itest-seller"]);

    const { db: qdb, client } = createDatabase({ DATABASE_URL: url });
    try {
      const forSeller = await qdb.transaction(async (tx) =>
        listAdminRuns(tx, { market: "Balogun", status: null, runnerId: null, storeId: "itest-seller", kind: null }, { limit: 50, offset: 0 }),
      );
      expect(forSeller.items.map((item) => item.runId)).toEqual(["itest-live-1"]);

      const forOther = await qdb.transaction(async (tx) =>
        listAdminRuns(tx, { market: "Balogun", status: null, runnerId: null, storeId: "someone-else", kind: null }, { limit: 50, offset: 0 }),
      );
      expect(forOther.items.map((item) => item.runId)).toEqual(["itest-live-2"]);

      // No filters = unchanged behavior: both live runs and the archived one.
      const all = await qdb.transaction(async (tx) =>
        listAdminRuns(tx, { market: "Balogun", status: null, runnerId: null, storeId: null, kind: null }, { limit: 50, offset: 0 }),
      );
      expect(all.total).toBe(3);
    } finally {
      await client.end();
    }
  });

  it("computes reputation from the durable record", async () => {
    const { db: qdb, client } = createDatabase({ DATABASE_URL: url });
    try {
      const buyer = await qdb.transaction(async (tx) => loadReputation(tx, "itest-buyer", "buyer"));
      expect(JSON.parse(JSON.stringify(buyer))).toEqual(computeReputation("itest-buyer", [
        { runId: "itest-run-1", mode: "completed", role: "buyer" },
      ]));
      expect(buyer.completedTrips).toBe(1);
      expect(buyer.standingBps).toBe(10_000);

      const seller = await qdb.transaction(async (tx) => loadReputation(tx, "itest-seller", "seller"));
      expect(seller.completedTrips).toBe(1);

      const stranger = await qdb.transaction(async (tx) => loadReputation(tx, "nobody", "runner"));
      expect(stranger.completedTrips).toBe(0);
    } finally {
      await client.end();
    }
  });
});
