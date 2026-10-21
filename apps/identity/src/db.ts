import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../infra/drizzle/schema.js";

/** Same seam as apps/archive: Postgres is the system of record (ADR-0011); the edge never touches it. */
export interface DatabaseEnv {
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
}

export function createDatabase(env: DatabaseEnv) {
  const connectionString = env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString;
  if (!connectionString) throw new Error("DATABASE_URL or HYPERDRIVE connection is required");
  const client = postgres(connectionString, { max: 1, prepare: false });
  return { db: drizzle(client, { schema }), client };
}
