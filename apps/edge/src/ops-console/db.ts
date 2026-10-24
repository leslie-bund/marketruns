import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../../infra/drizzle/schema.js";
import type { Env } from "../config/env.js";

export type OpsDatabase = ReturnType<typeof createOpsDatabase>["db"];

/** Hyperdrive in deployed Workers; DATABASE_URL is the explicit local adapter. */
export function createOpsDatabase(env: Pick<Env, "DATABASE_URL" | "HYPERDRIVE">) {
  const connectionString = env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString;
  if (!connectionString) throw new Error("OPS database unavailable: configure HYPERDRIVE or local DATABASE_URL");
  const client = postgres(connectionString, { max: 1, prepare: false });
  return { db: drizzle(client, { schema }), client };
}

export function databaseConfigured(env: Pick<Env, "DATABASE_URL" | "HYPERDRIVE">): boolean {
  return Boolean(env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString);
}
