import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const execFileAsync = promisify(execFile);

/** The dev container every local run shares (infra/dev-all.sh) — session/dev data lives here. */
export const DEV_DATABASE_URL = "postgres://postgres:postgres@localhost:54322/market_runs";

/**
 * Integration suites get their own database inside the same container. The
 * suites truncate their tables in teardown; pointing them at DEV_DATABASE_URL
 * would delete the settlement/ledger/dispatch rows a live session just
 * produced — the exact rows infra/reconcile.mjs audits. Same container,
 * separate database: hermetic tests, untouched dev evidence.
 */
export const TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:54322/market_runs_test";

const TEST_DATABASE_NAME = "market_runs_test";
const MAINTENANCE_URL = "postgres://postgres:postgres@localhost:54322/postgres";

const CONTAINER = "market-runs-postgres";
const POLL_INTERVAL_MS = 5_000;
/** Grace for a concurrent dev-all migrate before we apply migrations ourselves. */
const MIGRATION_GRACE_MS = 30_000;
const MIGRATION_RETRY_DELAY_MS = 10_000;

/** `infra/drizzle`, resolved from this module — suites run with different cwds. */
const DRIZZLE_DIR = fileURLToPath(new URL("../../../infra/drizzle", import.meta.url));

const START_HINT =
  "ensure Postgres is running — for the local dev container: npx pnpm@9.15.4 dev:all or docker start market-runs-postgres";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command: string, args: string[]): Promise<string> {
  return execFileAsync(command, args).then(({ stdout }) => stdout);
}

/**
 * Fail loudly when a Docker daemon / container call errors, carrying stderr so
 * the developer sees the real reason (docker down, psql missing…).
 */
async function checked(command: string, args: string[], label: string): Promise<string> {
  try {
    return await run(command, args);
  } catch (cause) {
    const stderr = (cause as { stderr?: string }).stderr?.trim();
    throw new Error(`integration test DB: ${label} failed${stderr ? ` — ${stderr}` : ""}. ${START_HINT}`, {
      cause,
    });
  }
}

async function probe(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 5 });
  try {
    await sql`SELECT 1`;
  } catch (cause) {
    throw new Error(`integration test DB: cannot reach Postgres at ${databaseUrl}. ${START_HINT}`, { cause });
  } finally {
    await sql.end();
  }
}

/** Applied migrations in the target database; 0 when the drizzle schema is absent. */
async function migrationCount(databaseUrl: string): Promise<number> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 5 });
  try {
    const rows = await sql<{ count: string }[]>`SELECT count(*) FROM drizzle.__drizzle_migrations`;
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  } finally {
    await sql.end();
  }
}

async function waitForMigrations(databaseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if ((await migrationCount(databaseUrl)) > 0) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return (await migrationCount(databaseUrl)) > 0;
}

async function ensureContainer(): Promise<void> {
  try {
    await run("docker", ["info"]);
  } catch (cause) {
    throw new Error(`integration test DB: docker daemon is not reachable. ${START_HINT}`, { cause });
  }
  const names = await checked("docker", ["ps", "-a", "--format", "{{.Names}}"], "listing containers");
  if (names.split("\n").includes(CONTAINER)) {
    await checked("docker", ["start", CONTAINER], `starting container ${CONTAINER}`);
  } else {
    await checked(
      "docker",
      [
        "run", "-d", "--name", CONTAINER,
        "-e", "POSTGRES_PASSWORD=postgres",
        "-e", "POSTGRES_DB=market_runs",
        "-p", "54322:5432",
        "postgres:16-alpine",
      ],
      "creating the dev postgres container",
    );
  }
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await run("docker", ["exec", CONTAINER, "pg_isready", "-U", "postgres", "-d", "market_runs"]);
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`integration test DB: postgres in ${CONTAINER} did not become ready in 60s — check: docker logs ${CONTAINER}`);
      }
      await sleep(1_000);
    }
  }
}

/** Create the dedicated test database on first use (the container only creates `market_runs`). */
async function ensureTestDatabase(): Promise<void> {
  const admin = postgres(MAINTENANCE_URL, { max: 1, prepare: false, connect_timeout: 5 });
  try {
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${TEST_DATABASE_NAME}`;
    if (rows.length === 0) {
      await admin.unsafe(`CREATE DATABASE "${TEST_DATABASE_NAME}"`);
    }
  } finally {
    await admin.end();
  }
}

async function applyMigrations(databaseUrl: string): Promise<void> {
  const args = ["drizzle-kit", "migrate"];
  const options = { cwd: DRIZZLE_DIR, env: { ...process.env, DATABASE_URL: databaseUrl } };
  try {
    await execFileAsync("npx", args, options);
  } catch (first) {
    // Two suites (or a teammate's dev-all) can migrate concurrently: the loser
    // hits a relation-exists race. Wait for the winner, then retry once.
    await sleep(MIGRATION_RETRY_DELAY_MS);
    try {
      await execFileAsync("npx", args, options);
    } catch (second) {
      const stderr = (second as { stderr?: string }).stderr?.trim();
      throw new Error(`integration test DB: drizzle-kit migrate failed${stderr ? ` — ${stderr}` : ""}. ${START_HINT}`, {
        cause: second ?? first,
      });
    }
  }
}

export interface IntegrationDatabaseOptions {
  /** Per-suite env var override (ARCHIVE_TEST_DATABASE_URL / PAYMENTS_TEST_DATABASE_URL). */
  envVar: string;
}

/**
 * Resolve the Postgres a real-database integration suite runs against and make
 * sure it is migrated — integration suites are first-class, never silently
 * skipped.
 *
 * Default: the dedicated `market_runs_test` database inside the shared dev
 * container (created and migrated on first use). Never the dev database: the
 * suites TRUNCATE their tables, and `market_runs` holds the live-session
 * settlement/ledger/dispatch evidence that reconcile.mjs audits.
 *
 * Override: `<envVar>` from the environment wins, for pointing a suite at a
 * different database; it is migrated when empty (short grace for a concurrent
 * dev-all), never started/created.
 *
 * An unreachable database or any setup failure throws with an actionable
 * message — the suite fails rather than skips.
 */
export async function resolveIntegrationDatabase({ envVar }: IntegrationDatabaseOptions): Promise<string> {
  const override = process.env[envVar]?.trim();

  if (override) {
    await probe(override);
    await waitForMigrations(override, MIGRATION_GRACE_MS);
    await applyMigrations(override);
    return override;
  }

  await ensureContainer();
  await ensureTestDatabase();
  await probe(TEST_DATABASE_URL);
  await applyMigrations(TEST_DATABASE_URL);
  return TEST_DATABASE_URL;
}
