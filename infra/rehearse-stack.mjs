#!/usr/bin/env node
/** Start the full local stack, run the real-wire rehearsal, always clean up. */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const root = new URL("..", import.meta.url).pathname;
const child = spawn("npx", ["--yes", "pnpm@9.15.4", "dev:all"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
let finished = false;
child.once("exit", () => { finished = true; });

async function stop() {
  if (!finished) child.kill("SIGTERM");
  const cleanup = spawn("npx", ["--yes", "pnpm@9.15.4", "dev:stop"], { cwd: root, stdio: "inherit" });
  await new Promise((resolve) => cleanup.once("exit", resolve));
}

try {
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
  const rehearsal = spawn("npx", ["--yes", "pnpm@9.15.4", "test:e2e"], { cwd: root, stdio: "inherit", env: process.env });
  const code = await new Promise((resolve) => rehearsal.once("exit", resolve));
  if (code !== 0) process.exitCode = typeof code === "number" ? code : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await stop();
}
