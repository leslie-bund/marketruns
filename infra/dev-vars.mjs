/**
 * Load `infra/.dev.vars` into `process.env` for the local ops scripts
 * (reconcile + the e2e rehearsal).
 *
 * Wrangler reads this file for the workers, but plain Node does not. Without
 * this loader `node infra/reconcile.mjs` sees no `FLUTTERWAVE_SECRET_KEY` and
 * silently SKIPs the vendor tie-out even while the stack is moving real
 * test-mode transfers. Existing shell env vars always win; the file is
 * gitignored and never printed.
 *
 * This is deliberately a tiny dotenv parser, not a dependency: values are
 * single-line `KEY=VALUE`, matching-wrapped quotes are stripped, comments and
 * malformed lines are ignored.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEV_VARS_PATH = fileURLToPath(new URL("./.dev.vars", import.meta.url));

export function loadDevVars(file = DEV_VARS_PATH) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  return true;
}
