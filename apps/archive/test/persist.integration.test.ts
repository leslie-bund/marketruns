import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPaymentDispatchRequest,
  buildPaymentRefundRequest,
  computeReputation,
} from "@market-runs/domain";
import { resolveIntegrationDatabase } from "@market-runs/test-db";
import {
  archivedProducts,
  disputes,
  ledgerEntries,
  liveRuns,
  runsArchive,
  settlementRecords,
} from "../../../infra/drizzle/schema.js";
import { listAdminDisputes, listAdminRuns } from "../src/admin.js";
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
  const noopPaymentQueue = {
    send: async () => undefined,
    sendBatch: async () => undefined,
  } as unknown as Queue;
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
        settlementLegs: [{ sellerId: "itest-seller", amountKobo: 148_500 }],
        runnerKobo: 160_000,
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
        sellers: [{ sellerId: "itest-seller", amountKobo: 148_500 }],
        runnerKobo: 160_000,
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
    const env = { DATABASE_URL: url, PAYMENT_QUEUE: noopPaymentQueue };
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
    expect(debited).toBe(335_000);

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
    const env = { DATABASE_URL: url, PAYMENT_QUEUE: noopPaymentQueue };
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

  const queueMessage = (
    id: string,
    value: unknown,
    ack: () => void = () => undefined,
    retry: (options?: { delaySeconds?: number }) => void = () => undefined,
  ) => ({ id, body: JSON.stringify(value), ack, retry }) as unknown as Message;

  it("makes the committed canonical dispatch visible to another connection before send", async () => {
    const runId = "itest-payment-commit";
    const retired = {
      ...JSON.parse(batch[0]!.body as string),
      runId,
      cartId: `${runId}-cart`,
      buyerId: "itest-payment-buyer",
      settlementLegs: [{ sellerId: "itest-payment-seller", amountKobo: 148_500 }],
    };
    const released = {
      ...JSON.parse(batch[1]!.body as string),
      runId,
      buyerId: "itest-payment-buyer",
      requestId: "req-archive-payment-commit",
      sellers: [{ sellerId: "itest-payment-seller", amountKobo: 148_500 }],
      inputs: {
        ...JSON.parse(batch[1]!.body as string).inputs,
        sellers: [{ sellerId: "itest-payment-seller", amountKobo: 165_000, stopCompleted: true }],
      },
    };
    const bodies: unknown[] = [];
    let visibleBeforeSend: unknown;
    const paymentQueue = {
      send: async () => undefined,
      sendBatch: async (messages: Array<{ body: unknown }>) => {
        // This connection is independent of the consumer's transaction. Seeing
        // the joined row here proves the commit happened before queue emission.
        const rows = await db
          .select({
            settlementId: settlementRecords.id,
            market: runsArchive.marketId,
            buyerId: runsArchive.buyerId,
            runnerId: runsArchive.runnerId,
          })
          .from(settlementRecords)
          .innerJoin(runsArchive, eq(settlementRecords.runId, runsArchive.id))
          .where(eq(settlementRecords.runId, runId));
        visibleBeforeSend = rows[0];
        bodies.push(...messages.map((message) => message.body));
      },
    } as unknown as Queue;

    await consumer.queue(
      { messages: [queueMessage("m-payment-run", retired), queueMessage("m-payment-settlement", released)], queue: "archive-snapshots", retryAll: () => undefined } as unknown as MessageBatch<unknown>,
      { DATABASE_URL: url, PAYMENT_QUEUE: paymentQueue },
    );

    expect(visibleBeforeSend).toEqual({
      settlementId: `${runId}:settlement`,
      market: "Balogun",
      buyerId: "itest-payment-buyer",
      runnerId: "runner:internal",
    });
    expect(bodies).toEqual([
      buildPaymentDispatchRequest(
        {
          sellers: released.sellers,
          runnerKobo: released.runnerKobo,
          platformKobo: released.platformKobo,
          buyerRefundKobo: released.buyerRefundKobo,
          platformLossKobo: released.platformLossKobo,
        },
        { runId, market: "Balogun", runnerId: "runner:internal", requestId: released.requestId },
      ),
    ]);
  });

  it("retries failed payment emission without rollback and replays identical dispatch and refund bodies", async () => {
    const runId = "itest-payment-retry";
    const retired = {
      ...JSON.parse(batch[0]!.body as string),
      runId,
      cartId: `${runId}-cart`,
      buyerId: "itest-payment-buyer",
      status: "aborted",
      mode: "aborted",
      settlementLegs: [{ sellerId: "itest-payment-seller", amountKobo: 0 }],
    };
    const released = {
      ...JSON.parse(batch[1]!.body as string),
      runId,
      buyerId: "event-buyer-must-not-be-used",
      runnerId: "event-runner-must-not-be-used",
      requestId: "req-archive-payment-retry",
      mode: "aborted",
      sellers: [{ sellerId: "itest-payment-seller", amountKobo: 0 }],
      runnerKobo: 32_500,
      platformKobo: 27_000,
      buyerRefundKobo: 275_500,
      inputs: {
        ...JSON.parse(batch[1]!.body as string).inputs,
        mode: "aborted",
        sellers: [{ sellerId: "itest-payment-seller", amountKobo: 165_000, stopCompleted: false }],
      },
    };
    await consumer.queue(
      { messages: [queueMessage("m-retry-run", retired)], queue: "archive-snapshots", retryAll: () => undefined } as unknown as MessageBatch<unknown>,
      { DATABASE_URL: url, PAYMENT_QUEUE: noopPaymentQueue },
    );

    const deliveries: unknown[][] = [];
    let failNextSend = true;
    const paymentQueue = {
      send: async () => undefined,
      sendBatch: async (messages: Array<{ body: unknown }>) => {
        deliveries.push(messages.map((message) => message.body));
        if (failNextSend) {
          failNextSend = false;
          throw new Error("payment queue unavailable");
        }
      },
    } as unknown as Queue;
    let firstAcks = 0;
    const retries: Array<{ delaySeconds?: number } | undefined> = [];
    const env = { DATABASE_URL: url, PAYMENT_QUEUE: paymentQueue };

    // Standalone redelivery: market/buyer/runner must come from runs_archive,
    // not from this event's deliberately stale identity fields.
    await consumer.queue(
      {
        messages: [queueMessage("m-retry-settlement", released, () => { firstAcks += 1; }, (options) => { retries.push(options); })],
        queue: "archive-snapshots",
        retryAll: () => undefined,
      } as unknown as MessageBatch<unknown>,
      env,
    );

    expect(firstAcks).toBe(0);
    expect(retries).toEqual([{ delaySeconds: 30 }]);
    const [committed] = await db.select().from(settlementRecords).where(eq(settlementRecords.runId, runId));
    expect(committed?.id).toBe(`${runId}:settlement`);
    const legsAfterFailure = await db.select().from(ledgerEntries).where(eq(ledgerEntries.settlementRecordId, `${runId}:settlement`));
    expect(legsAfterFailure.length).toBeGreaterThan(0);

    let secondAcks = 0;
    await consumer.queue(
      { messages: [queueMessage("m-retry-settlement", released, () => { secondAcks += 1; })], queue: "archive-snapshots", retryAll: () => undefined } as unknown as MessageBatch<unknown>,
      env,
    );

    expect(secondAcks).toBe(1);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toEqual(deliveries[0]);
    const outcome = {
      sellers: released.sellers,
      runnerKobo: released.runnerKobo,
      platformKobo: released.platformKobo,
      buyerRefundKobo: released.buyerRefundKobo,
      platformLossKobo: released.platformLossKobo,
    };
    expect(deliveries[0]).toEqual([
      buildPaymentDispatchRequest(outcome, {
        runId,
        market: "Balogun",
        runnerId: "runner:internal",
        requestId: released.requestId,
      }),
      buildPaymentRefundRequest(outcome, {
        runId,
        buyerId: "itest-payment-buyer",
        requestId: released.requestId,
      }),
    ]);
    const settlements = await db.select().from(settlementRecords).where(eq(settlementRecords.runId, runId));
    const legsAfterReplay = await db.select().from(ledgerEntries).where(eq(ledgerEntries.settlementRecordId, `${runId}:settlement`));
    expect(settlements).toHaveLength(1);
    expect(legsAfterReplay).toHaveLength(legsAfterFailure.length);
  });

  describe("durable dispute resolution", () => {
    type SettlementMode = "completed" | "aborted" | "disputed";

    const archiveEvents = async (...values: unknown[]) => {
      await consumer.queue(
        {
          messages: values.map((value, index) => queueMessage(`m-dispute-${index}-${JSON.stringify(value).length}`, value)),
          queue: "archive-snapshots",
          retryAll: () => undefined,
        } as unknown as MessageBatch<unknown>,
        { DATABASE_URL: url, PAYMENT_QUEUE: noopPaymentQueue },
      );
    };

    const retirementFor = (runId: string, mode: SettlementMode, withDispute: boolean) => {
      const retired = {
        ...JSON.parse(batch[0]!.body as string),
        runId,
        cartId: `${runId}-cart`,
        buyerId: `${runId}-buyer`,
        settlementLegs: [{ sellerId: `${runId}-seller`, amountKobo: 148_500 }],
        status: mode === "aborted" ? "aborted" : "closed",
        mode,
        closedAt: now,
        dispute: {
          reason: "original participant reason",
          raisedByParticipantId: "original-raiser",
          evidenceRefs: ["r2://evidence/original.jpg"],
        },
      };
      if (!withDispute) delete retired.dispute;
      return retired;
    };

    const settlementFor = (
      runId: string,
      mode: SettlementMode,
      disputeInput?: { ambiguous: boolean },
    ) => ({
      ...JSON.parse(batch[1]!.body as string),
      runId,
      buyerId: `${runId}-buyer`,
      sellers: [{ sellerId: `${runId}-seller`, amountKobo: 148_500 }],
      mode,
      platformLossKobo: mode === "disputed" ? 5_000 : 0,
      releasedAt: now + 60_000,
      inputs: {
        ...JSON.parse(batch[1]!.body as string).inputs,
        sellers: [{ sellerId: `${runId}-seller`, amountKobo: 165_000, stopCompleted: true }],
        mode,
        ...(disputeInput ? { dispute: disputeInput } : {}),
      },
    });

    it("resolves an existing dispute without losing its evidence, survives replay, and is listed as resolved", async () => {
      const runId = "itest-dispute-existing";
      const retired = retirementFor(runId, "disputed", true);
      const released = settlementFor(runId, "disputed", { ambiguous: true });

      await archiveEvents(retired, released);
      await archiveEvents(released, retired);
      await archiveEvents(retired);

      const rows = await db.select().from(disputes).where(eq(disputes.runId, runId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: `${runId}:dispute`,
        runId,
        settlementRecordId: `${runId}:settlement`,
        raisedByParticipantId: "original-raiser",
        reason: "original participant reason",
        evidenceRefs: ["r2://evidence/original.jpg"],
        ambiguous: true,
        absorbedLossKobo: 5_000,
        status: "resolved",
        createdAt: new Date(now),
        resolvedAt: new Date(now + 60_000),
      });

      const resolved = await db.transaction((tx) =>
        listAdminDisputes(tx, { status: "resolved" }, { limit: 50, offset: 0 }),
      );
      expect(resolved.items.find((item) => item.runId === runId)).toMatchObject({
        settlementRecordId: `${runId}:settlement`,
        status: "resolved",
        resolvedAt: now + 60_000,
        ambiguous: true,
        absorbedLossKobo: 5_000,
      });
    });

    it("creates one resolved Ops-originated synthetic dispute for a disputed settlement without a dispute block", async () => {
      const runId = "itest-dispute-synthetic";
      await archiveEvents(
        retirementFor(runId, "disputed", false),
        settlementFor(runId, "disputed"),
      );
      await archiveEvents(settlementFor(runId, "disputed"));

      const rows = await db.select().from(disputes).where(eq(disputes.runId, runId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: `${runId}:dispute`,
        runId,
        settlementRecordId: `${runId}:settlement`,
        raisedByParticipantId: "unknown",
        reason: "",
        evidenceRefs: [],
        ambiguous: true,
        absorbedLossKobo: 5_000,
        status: "resolved",
        createdAt: new Date(now + 60_000),
        resolvedAt: new Date(now + 60_000),
      });
    });

    it.each([
      { mode: "completed" as const, withDispute: true },
      { mode: "completed" as const, withDispute: false },
      { mode: "aborted" as const, withDispute: true },
      { mode: "aborted" as const, withDispute: false },
    ])("handles $mode settlement with existing dispute=$withDispute", async ({ mode, withDispute }) => {
      const runId = `itest-dispute-${mode}-${withDispute}`;
      await archiveEvents(
        retirementFor(runId, mode, withDispute),
        settlementFor(runId, mode),
      );

      const rows = await db.select().from(disputes).where(eq(disputes.runId, runId));
      if (!withDispute) {
        expect(rows).toEqual([]);
        return;
      }
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        settlementRecordId: `${runId}:settlement`,
        raisedByParticipantId: "original-raiser",
        reason: "original participant reason",
        evidenceRefs: ["r2://evidence/original.jpg"],
        ambiguous: false,
        absorbedLossKobo: 0,
        status: "resolved",
        createdAt: new Date(now),
        resolvedAt: new Date(now + 60_000),
      });
    });
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
