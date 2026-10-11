/**
 * Drizzle Kit config for the Postgres system of record (ADR-0011).
 *
 * The database connection string is NEVER hardcoded. It comes from the
 * environment at invocation time:
 *   - `DATABASE_URL` — the Neon connection string (used when running
 *     `drizzle-kit generate` / `drizzle-kit migrate` from a developer machine
 *     or CI, connecting to Neon directly rather than through Hyperdrive).
 *   - `HYPERDRIVE` — fallback, matching the Worker binding name in
 *     infra/wrangler.edge.toml.
 *
 * The Neon connection string is a secret: set via `wrangler secret put` for
 * the runtime binding and via an env var / CI secret for migrations. Never
 * commit it (infra/README.md).
 */
import { defineConfig } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL ?? process.env.HYPERDRIVE;

if (connectionString === undefined || connectionString === "") {
  throw new Error(
    "drizzle.config: set DATABASE_URL (Neon connection string) or HYPERDRIVE in the environment; it is never hardcoded.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./schema.ts",
  out: "./migrations",
  dbCredentials: { url: connectionString },
  strict: true,
  verbose: true,
});
