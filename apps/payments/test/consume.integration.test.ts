import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveIntegrationDatabase } from "@market-runs/test-db";
import { paymentDispatches, paymentHolds, paymentRefunds, runsArchive, settlementRecords } from "../../../infra/drizzle/schema.js";
import worker from "../src/index.js";
import { FakeMessage, sampleDispatchRequest, sampleRefundRequest, sampleSettlementAuthorization } from "./helpers.js";
import type { Env } from "../src/env.js";

/**
 * Functional integration test for the payments pipeline — first-class: it runs
 * by default against the dedicated `market_runs_test` database in the dev
 * Postgres container (localhost:54322), created and migrated on first use, and
 * fails with an actionable message when the database is unreachable. It never
 * touches `market_runs`, where live-session dispatch evidence lives — this
 * suite TRUNCATEs payment_dispatches. Set PAYMENTS_TEST_DATABASE_URL to point
 * at a different database. The durable record is asserted for real: queue batch
 * → consumer → payment_dispatches rows → ops read, including the idempotency
 * unique index.
 */
let url: string;
let env: Env;
beforeAll(async () => {
  url = await resolveIntegrationDatabase({ envVar: "PAYMENTS_TEST_DATABASE_URL" });
  env = { DATABASE_URL: url, PAYMENT_DISPATCHER: "stub", PAYMENTS_INTERNAL_TOKEN: "integration-internal-token" };
}, 6 * 60_000);

describe("payments consumer against real Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  beforeAll(async () => {
    sql = postgres(url, { max: 1, prepare: false });
    db = drizzle(sql);
    // Hermetic start: a crashed prior run must not leak rows into the row-count
    // assertions below (the suite still truncates on exit too).
    await sql`TRUNCATE payment_dispatches, settlement_records, runs_archive CASCADE`;
  });
  afterAll(async () => {
    await sql`TRUNCATE payment_dispatches, settlement_records, runs_archive CASCADE`;
    await sql.end();
  });

  async function seedSettlement() {
    const authorization = sampleSettlementAuthorization();
    await db.insert(runsArchive).values({
      id: authorization.runId,
      cartId: "cart:Balogun:buyer:1",
      marketId: authorization.market,
      buyerId: authorization.buyerId,
      runnerId: authorization.runnerId,
      status: "closed",
      delivery: { kind: "muster-point", name: "Test point" },
      floorRateKobo: 160_000,
      closedAt: new Date(),
    });
    await db.insert(settlementRecords).values({
      id: authorization.settlementRecordId,
      runId: authorization.runId,
      mode: "completed",
      goodsTotalKobo: 165_000,
      runnerKobo: authorization.outcome.runnerKobo,
      platformKobo: authorization.outcome.platformKobo,
      buyerRefundKobo: authorization.outcome.buyerRefundKobo,
      platformLossKobo: authorization.outcome.platformLossKobo,
      inputs: {
        mode: "completed",
        sellers: [{ sellerId: "seller:amina", amountKobo: 165_000, stopCompleted: true }],
        deliveryPriceKobo: 170_000,
        deliveryMarginKobo: 10_000,
        goodsCommissionBps: 1_000,
      },
      outcome: authorization.outcome,
      releasedAt: new Date(),
    });
  }

  it("consumes payment.dispatch-requested, persists legs, and no-ops a duplicate delivery", async () => {
    await seedSettlement();
    const request = sampleDispatchRequest();
    const batch = (messages: FakeMessage[]) => ({ messages }) as unknown as MessageBatch<unknown>;
    const wire = JSON.stringify(request);

    const first = [new FakeMessage("m-1", wire), new FakeMessage("m-1-dupe", wire)];
    await worker.queue(batch(first), env);

    const rows = await db.select().from(paymentDispatches);
    expect(rows).toHaveLength(3); // duplicate delivery collapsed on the idempotency key
    expect(rows.every((row) => row.status === "sent")).toBe(true);
    expect(rows.every((row) => row.providerRef?.startsWith("stub:"))).toBe(true);
    expect(rows.every((row) => /^mr_[0-9a-f]{48}$/.test(row.providerReference ?? ""))).toBe(true);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
    expect(first.every((message) => message.acked)).toBe(true);

    // Ops read path over the same durable rows.
    const listed = await worker.fetch(
      new Request(`http://payments/dispatches?runId=${encodeURIComponent(request.runId)}`, {
        headers: { "x-payments-internal": "integration-internal-token" },
      }),
      env,
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { total: number; items: Array<{ idempotencyKey: string }> };
    expect(body.total).toBe(3);
    expect(body.items.map((item) => item.idempotencyKey).sort()).toEqual([
      "settlement:run:cart:Balogun:buyer:1:settlement:leg:0",
      "settlement:run:cart:Balogun:buyer:1:settlement:leg:1",
      "settlement:run:cart:Balogun:buyer:1:settlement:leg:2",
    ]);
  });

  it("refuses a schema-valid dispatch whose legs disagree with the durable settlement", async () => {
    await sql`TRUNCATE payment_dispatches`;
    const forged = sampleDispatchRequest({
      legs: [
        { account: "seller", partyId: "seller:attacker", amountKobo: 148_500, memo: "Seller settlement" },
        ...sampleDispatchRequest().legs.slice(1),
      ],
    });
    const message = new FakeMessage("mismatched-dispatch", JSON.stringify(forged));
    const batch = { messages: [message] } as unknown as MessageBatch<unknown>;

    await worker.queue(batch, env);

    expect(await db.select().from(paymentDispatches)).toHaveLength(0);
    expect(message.acked).toBe(true);
    expect(message.retries).toHaveLength(0);
  });

  it("refuses a schema-valid dispatch that has no durable settlement authorization", async () => {
    await sql`TRUNCATE payment_dispatches`;
    const forged = sampleDispatchRequest({
      settlementRecordId: "run:cart:Balogun:buyer:forged:settlement",
      runId: "run:cart:Balogun:buyer:forged",
      idempotencyKey: "settlement:run:cart:Balogun:buyer:forged:settlement",
    });
    const message = new FakeMessage("forged-dispatch", JSON.stringify(forged));
    const batch = { messages: [message] } as unknown as MessageBatch<unknown>;

    await worker.queue(batch, env);

    const rows = await db.select().from(paymentDispatches);
    expect(rows).toHaveLength(0);
    expect(message.acked).toBe(false);
    expect(message.retries).toEqual([{ delaySeconds: 30 }]);
  });

  it("redrives canonical messages from a real Postgres settlement", async () => {
    await sql`TRUNCATE settlement_records, runs_archive CASCADE`;
    await seedSettlement();
    const bodies: unknown[] = [];
    env.PAYMENT_QUEUE = {
      send: async (body: unknown): Promise<QueueSendResponse> => {
        bodies.push(body);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    } as unknown as Queue;

    try {
      const response = await worker.fetch(
        new Request("http://payments/settlements/run:cart:Balogun:buyer:1:settlement/redrive", {
          method: "POST",
          headers: { "x-payments-internal": "integration-internal-token" },
        }),
        env,
      );

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        settlementRecordId: "run:cart:Balogun:buyer:1:settlement",
        runId: "run:cart:Balogun:buyer:1",
        status: "enqueued",
        dispatchLegs: 3,
        refundDue: true,
        enqueuedCount: 2,
        failedCount: 0,
      });
      expect(bodies.map((body) => JSON.parse(body as string))).toEqual([
        sampleDispatchRequest(),
        sampleRefundRequest(),
      ]);
    } finally {
      delete env.PAYMENT_QUEUE;
    }
  });

  it("migration 0017 backfills only partial ambiguous refunds to refund-review", async () => {
    const holdId = "hold:migration-0017";
    const refundIds = [
      "refund:migration-full-ambiguous",
      "refund:migration-partial-ambiguous",
      "refund:migration-partial-definite",
    ];
    await sql`DELETE FROM payment_refunds WHERE id IN ${sql(refundIds)}`;
    await sql`DELETE FROM payment_holds WHERE id = ${holdId}`;
    try {
      await db.insert(paymentHolds).values({
        id: holdId,
        txRef: "migration-0017",
        providerTxId: "migration-provider-transaction",
        cartId: "cart:migration-0017",
        runId: null,
        buyerId: "buyer:migration-0017",
        amountKobo: 100_000,
        paymentMethod: "card",
        status: "held",
      });
      await db.insert(paymentRefunds).values([
        {
          id: refundIds[0]!, holdId, settlementRecordId: "settlement:migration-full", amountKobo: 100_000,
          status: "failed", failureReason: "provider-response-missing-refund",
        },
        {
          id: refundIds[1]!, holdId, settlementRecordId: "settlement:migration-partial", amountKobo: 40_000,
          status: "failed", failureReason: "provider-unreachable: timeout",
        },
        {
          id: refundIds[2]!, holdId, settlementRecordId: "settlement:migration-definite", amountKobo: 40_000,
          status: "failed", failureReason: "insufficient balance",
        },
      ]);
      const migration = await readFile(
        new URL("../../../infra/drizzle/migrations/0017_ambiguous_refund_review.sql", import.meta.url),
        "utf8",
      );
      await sql.unsafe(migration);

      const rows = await sql`SELECT id, status FROM payment_refunds WHERE id IN ${sql(refundIds)}`;
      expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({
        "refund:migration-full-ambiguous": "failed",
        "refund:migration-partial-ambiguous": "refund-review",
        "refund:migration-partial-definite": "failed",
      });
    } finally {
      await sql`DELETE FROM payment_refunds WHERE id IN ${sql(refundIds)}`;
      await sql`DELETE FROM payment_holds WHERE id = ${holdId}`;
    }
  });
});
