import { spawn } from "node:child_process";

const root = new URL("../..", import.meta.url).pathname;
const children = [
  spawn("npx", ["--yes", "pnpm@9.15.4", "dev:all"], { cwd: root, stdio: "inherit" }),
  spawn("npx", ["expo", "start", "--web", "--port", "8081"], {
    cwd: new URL(".", import.meta.url).pathname,
    stdio: "inherit",
    env: { ...process.env, EXPO_PUBLIC_EDGE_URL: "http://127.0.0.1:8787" },
  }),
];
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  const cleanup = spawn("npx", ["--yes", "pnpm@9.15.4", "dev:stop"], { cwd: root, stdio: "inherit" });
  cleanup.once("exit", () => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("exit", () => { for (const child of children) child.kill("SIGTERM"); });
