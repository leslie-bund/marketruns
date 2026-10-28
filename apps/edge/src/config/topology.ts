import type { Env } from "./env.js";

const DEPLOYED_ENVIRONMENTS = new Set(["staging", "production"]);
const SERVICE_URLS = ["OPS_ARCHIVE_URL", "IDENTITY_URL", "PAYMENTS_URL", "NOTIFICATIONS_URL"] as const;

/** Deployed workers never inherit the local proxy topology. */
export function validateEdgeTopology(env: Pick<Env, "EDGE_ENV" | (typeof SERVICE_URLS)[number]>): void {
  if (!env.EDGE_ENV || env.EDGE_ENV === "development" || env.EDGE_ENV === "test") return;
  if (!DEPLOYED_ENVIRONMENTS.has(env.EDGE_ENV)) throw new Error("EDGE_ENV must be development, test, staging, or production");
  for (const name of SERVICE_URLS) {
    const value = env[name];
    if (!value) throw new Error(`${name} is required when EDGE_ENV=${env.EDGE_ENV}`);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} must be an absolute HTTPS URL when EDGE_ENV=${env.EDGE_ENV}`);
    }
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"].includes(hostname) || hostname.endsWith(".localhost")) {
      throw new Error(`${name} must be a non-local HTTPS service URL when EDGE_ENV=${env.EDGE_ENV}`);
    }
  }
}
