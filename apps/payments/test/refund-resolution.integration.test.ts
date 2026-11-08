import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveIntegrationDatabase } from "@market-runs/test-db";
import { createDatabase } from "../src/db.js";
import { DrizzleRefundStore } from "../src/refunds.js";
import { paymentHolds, paymentRefundResolutions, paymentRefunds } from "../../../infra/drizzle/schema.js";

const accept = {
  action: "accept-provider",
  status: "processing",
  providerRef: "provider-integration-1",
  evidenceRef: "evidence/integration-1.json",
  note: "Provider evidence verified.",
} as const;

let database: ReturnType<typeof createDatabase>;
let store: DrizzleRefundStore;

beforeAll(async () => {
  const url = await resolveIntegrationDatabase({ envVar: "PAYMENTS_TEST_DATABASE_URL" });
  database = createDatabase({ DATABASE_URL: url });
  store = new DrizzleRefundStore(database.db);
  await database.client`DELETE FROM payment_refund_resolutions WHERE refund_id LIKE 'refund:resolution-integration-%'`;
  await database.client`DELETE FROM payment_refunds WHERE id LIKE 'refund:resolution-integration-%'`;
  await database.client`DELETE FROM payment_holds WHERE id LIKE 'hold:resolution-integration-%'`;
}, 6 * 60_000);

afterEach(async () => {
  await database.client`DELETE FROM payment_refund_resolutions WHERE refund_id LIKE 'refund:resolution-integration-%'`;
  await database.client`DELETE FROM payment_refunds WHERE id LIKE 'refund:resolution-integration-%'`;
  await database.client`DELETE FROM payment_holds WHERE id LIKE 'hold:resolution-integration-%'`;
});

afterAll(async () => {
  await database.client.end();
});

async function seed(id: string) {
  const holdId = `hold:resolution-integration-${id}`;
  const refundId = `refund:resolution-integration-${id}`;
  await database.db.insert(paymentHolds).values({
    id: holdId,
    txRef: holdId,
    providerTxId: `provider-transaction-${id}`,
    cartId: `cart:${id}`,
    runId: null,
    buyerId: "buyer:integration",
    amountKobo: 100_000,
    paymentMethod: "card",
    status: "held",
  });
  await database.db.insert(paymentRefunds).values({
    id: refundId,
    holdId,
    settlementRecordId: `settlement:${id}`,
    amountKobo: 100_000,
    status: "refund-review",
    failureReason: "reconciliation-conflict: integration",
    attempts: 2,
  });
  return refundId;
}

describe("refund resolutions against real Postgres", () => {
  it("serializes concurrent identical resolutions into one apply and one replay", async () => {
    const refundId = await seed("identical");

    const outcomes = await Promise.all([
      store.resolve(refundId, { resolvedBy: "ops:one", resolution: accept, resolvedAt: new Date() }),
      store.resolve(refundId, { resolvedBy: "ops:one", resolution: accept, resolvedAt: new Date() }),
    ]);

    expect(outcomes.map((result) => result.outcome).sort()).toEqual(["applied", "replayed"]);
    const persisted = await database.db.select().from(paymentRefundResolutions);
    expect(persisted).toHaveLength(1);
    const refund = await store.byId(refundId);
    expect(refund).toMatchObject({ status: "processing", attempts: 2, failureReason: null });
    expect(refund?.resolution).toMatchObject({ ...accept, resolvedBy: "ops:one" });
    const holds = await database.db.select().from(paymentHolds);
    expect(holds[0]?.status).toBe("refunded");
  });

  it("allows only one of two concurrent different fingerprints", async () => {
    const refundId = await seed("different");

    const outcomes = await Promise.all([
      store.resolve(refundId, { resolvedBy: "ops:one", resolution: accept, resolvedAt: new Date() }),
      store.resolve(refundId, {
        resolvedBy: "ops:one",
        resolution: { ...accept, evidenceRef: "evidence/different.json" },
        resolvedAt: new Date(),
      }),
    ]);

    expect(outcomes.map((result) => result.outcome).sort()).toEqual(["applied", "conflict"]);
    expect(await database.db.select().from(paymentRefundResolutions)).toHaveLength(1);
  });

  it("enforces the write-once key, foreign key, and action/status checks", async () => {
    const refundId = await seed("constraints");
    const valid = {
      refundId,
      action: "accept-provider",
      status: "processing",
      providerRef: "provider-integration-1",
      evidenceRef: "evidence/integration-1.json",
      note: "Provider evidence verified.",
      resolvedBy: "ops:one",
      resolvedAt: new Date(),
    };
    await database.db.insert(paymentRefundResolutions).values(valid);

    await expect(database.db.insert(paymentRefundResolutions).values(valid)).rejects.toThrow();
    await expect(database.db.insert(paymentRefundResolutions).values({
      ...valid,
      refundId: "refund:resolution-integration-missing",
    })).rejects.toThrow();
    await expect(database.db.insert(paymentRefundResolutions).values({
      ...valid,
      refundId: "refund:resolution-integration-bad-status",
      status: "failed",
    })).rejects.toThrow();
    await expect(database.db.insert(paymentRefundResolutions).values({
      ...valid,
      refundId: "refund:resolution-integration-bad-retry",
      action: "allow-retry",
      status: "failed",
      providerRef: null,
      evidenceRef: " ",
    })).rejects.toThrow();
  });
});
