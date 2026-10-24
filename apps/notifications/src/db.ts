import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export interface DatabaseEnv {
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
}

export function createDatabase(env: DatabaseEnv) {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL or HYPERDRIVE is required");
  const client = postgres(connectionString, { max: 1, prepare: false });
  return { db: drizzle(client), client };
}
