import assert from "node:assert/strict";
import { getTableName } from "drizzle-orm";
import * as schema from "../../../infra/drizzle/schema.js";
import { createOpsAuth } from "../src/ops-console/auth.js";
import type { OpsDatabase } from "../src/ops-console/db.js";

/** No-write probe: every adapter read is answered by this in-memory stub. */
async function main() {
  const tables: string[] = [];
  const db = {
    _: { fullSchema: schema },
    select: () => ({
      from: (table: unknown) => {
        tables.push(getTableName(table as Parameters<typeof getTableName>[0]));
        return { where: async () => [] };
      },
    }),
  } as unknown as OpsDatabase;
  const auth = createOpsAuth({
    OPS_AUTH_SECRET: "probe-only-not-a-production-secret-0123456789",
    OPS_BASE_URL: "http://localhost:8787",
    OPS_LOCAL_DEV: "true",
  }, db);
  const context = await auth.$context;

  await context.internalAdapter.findUserByEmail("admin@marketruns.test");
  for (const [model, field] of [["session", "token"], ["account", "accountId"], ["verification", "identifier"]] as const) {
    assert.equal(await context.adapter.findOne({ model, where: [{ field, value: "probe" }] }), null);
  }
  assert.deepEqual(tables, ["user", "session", "account", "verification"]);
  console.log("ops auth probe passed: user/session/account/verification resolved to the ops Drizzle tables; no database writes performed");
}

await main();
