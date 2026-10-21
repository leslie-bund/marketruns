import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveIntegrationDatabase } from "@market-runs/test-db";
import { paymentDispatches } from "../../../infra/drizzle/schema.js";
import worker from "../src/index.js";
import { FakeMessage, sampleDispatchRequest } from "./helpers.js";
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
  env = { DATABASE_URL: url, PAYMENT_DISPATCHER: "stub" };
}, 6 * 60_000);

describe("payments consumer against real Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  beforeAll(async () => {
    sql = postgres(url, { max: 1, prepare: false });
    db = drizzle(sql);
    // Hermetic start: a crashed prior run must not leak rows into the row-count
    // assertions below (the suite still truncates on exit too).
    await sql`TRUNCATE payment_dispatches`;
  });
  afterAll(async () => {
    await sql`TRUNCATE payment_dispatches`;
    await sql.end();
  });

  it("consumes payment.dispatch-requested, persists legs, and no-ops a duplicate delivery", async () => {
    const request = sampleDispatchRequest();
    const batch = (messages: FakeMessage[]) => ({ messages }) as unknown as MessageBatch<unknown>;
    const wire = JSON.stringify(request);

    const first = [new FakeMessage("m-1", wire), new FakeMessage("m-1-dupe", wire)];
    await worker.queue(batch(first), env);

    const rows = await db.select().from(paymentDispatches);
    expect(rows).toHaveLength(3); // duplicate delivery collapsed on the idempotency key
    expect(rows.every((row) => row.status === "sent")).toBe(true);
    expect(rows.every((row) => row.providerRef?.startsWith("stub:"))).toBe(true);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
    expect(first.every((message) => message.acked)).toBe(true);

    // Ops read path over the same durable rows.
    const listed = await worker.fetch(
      new Request(`http://payments/dispatches?runId=${encodeURIComponent(request.runId)}`),
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
});
