#!/usr/bin/env node
/** Verify migration 0018, launch-market seed, and first ops admin without printing credentials. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(new URL("../apps/payments/package.json", import.meta.url));
const postgres = require("postgres");

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!process.env.LAUNCH_MARKET) throw new Error("LAUNCH_MARKET is required");

const journal = JSON.parse(fs.readFileSync(path.join(root, "infra/drizzle/migrations/meta/_journal.json"), "utf8"));
const entry = journal.entries.find((candidate) => candidate.tag.startsWith("0018_"));
if (!entry) throw new Error("migration journal entry 0018 is missing");
const sql = fs.readFileSync(path.join(root, `infra/drizzle/migrations/${entry.tag}.sql`), "utf8");
const expectedHash = crypto.createHash("sha256").update(sql).digest("hex");
const client = postgres(process.env.DATABASE_URL, {
  max: 1,
  connect_timeout: 10,
  idle_timeout: 5,
  prepare: false,
});

let failed = false;
try {
  const migrations = await client`
    select hash, created_at from drizzle.__drizzle_migrations where created_at = ${entry.when}::numeric
  `;
  if (migrations.length === 1 && migrations[0].hash === expectedHash) {
    console.log("PASS database: migration 0018 hash is present");
  } else {
    console.error("FAIL database: migration 0018 is absent or has a different hash");
    failed = true;
  }

  const refundResolution = await client`select to_regclass('public.payment_refund_resolutions') as table_name`;
  if (refundResolution[0]?.table_name) console.log("PASS database: 0018 refund-resolution schema exists");
  else {
    console.error("FAIL database: payment_refund_resolutions is missing");
    failed = true;
  }

  const market = await client`select id from markets where id = ${process.env.LAUNCH_MARKET}`;
  if (market.length === 1) console.log("PASS database: launch market is seeded");
  else {
    console.error("FAIL database: launch market is not seeded");
    failed = true;
  }

  const admins = await client`select count(*)::integer as count from "user" where role = 'admin'`;
  if ((admins[0]?.count ?? 0) > 0) console.log("PASS database: at least one ops admin exists");
  else {
    console.error("FAIL database: no ops admin exists");
    failed = true;
  }
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? ` (${error.code})` : "";
  console.error(`FAIL database: staging verification query failed${code}`);
  failed = true;
} finally {
  await client.end();
}

process.exit(failed ? 1 : 0);
