#!/usr/bin/env node
/** Hermetic real-stack rehearsal: fresh DB, five workers, guaranteed cleanup. */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const root = new URL("..", import.meta.url).pathname;
const database = `market_runs_rehearsal_${Date.now().toString(36)}`;
const databaseUrl = `postgres://postgres:postgres@localhost:54322/${database}`;
const env = { ...process.env, DATABASE_URL: databaseUrl };
let child;
let finished = false;
let databaseCreated = false;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    process.once("error", reject);
    process.once("exit", (code) => resolve(code ?? 1));
  });
}

async function sql(statement) {
  const code = await run("docker", ["exec", "market-runs-postgres", "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", statement]);
  if (code !== 0) throw new Error(`temporary database command failed (${code})`);
}

async function stop() {
  if (child && !finished) child.kill("SIGTERM");
  await run("npx", ["--yes", "pnpm@9.15.4", "dev:stop"]);
  if (databaseCreated && process.env.KEEP_REHEARSAL_DB !== "1") {
    await run("docker", ["exec", "market-runs-postgres", "psql", "-U", "postgres", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`]);
  } else if (databaseCreated) {
    console.log(`preserved rehearsal database for debugging: ${database}`);
  }
}

try {
  // Reuse the local Postgres container; dev:all still owns worker lifecycle.
  const started = await run("docker", ["start", "market-runs-postgres"]);
  if (started !== 0) throw new Error("start the market-runs-postgres container first (dev:all creates it)");
  await sql(`CREATE DATABASE "${database}"`);
  databaseCreated = true;
  console.log(`temporary rehearsal database: ${database}`);

  child = spawn("npx", ["--yes", "pnpm@9.15.4", "dev:all"], { cwd: root, stdio: "inherit", env });
  child.once("exit", () => { finished = true; });

  let ready = false;
  const ports = [8787, 8788, 8789, 8790, 8791];
  for (let attempt = 0; attempt < 180 && !finished; attempt += 1) {
    const health = await Promise.all(ports.map(async (port) => {
      try {
        const response = await fetch(`http://localhost:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
        return response.ok;
      } catch { return false; }
    }));
    if (health.every(Boolean)) { ready = true; break; }
    await delay(1000);
  }
  if (!ready) throw new Error("the five-worker stack did not become ready within 180 seconds");
  await delay(2000);
  const code = await run("npx", ["--yes", "pnpm@9.15.4", "test:e2e"], { env });
  if (code !== 0) process.exitCode = code;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await stop();
}
