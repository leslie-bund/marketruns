import type { Env } from "./env.js";

/** Queue delivery must not silently call a developer's loopback edge. */
export function validateNotificationsTopology(env: Pick<Env, "NOTIFICATIONS_ENV" | "EDGE_URL">): void {
  if (!env.NOTIFICATIONS_ENV || env.NOTIFICATIONS_ENV === "development" || env.NOTIFICATIONS_ENV === "test") return;
  if (env.NOTIFICATIONS_ENV !== "staging" && env.NOTIFICATIONS_ENV !== "production") {
    throw new Error("NOTIFICATIONS_ENV must be development, test, staging, or production");
  }
  if (!env.EDGE_URL) throw new Error(`EDGE_URL is required when NOTIFICATIONS_ENV=${env.NOTIFICATIONS_ENV}`);
  let url: URL;
  try {
    url = new URL(env.EDGE_URL);
  } catch {
    throw new Error(`EDGE_URL must be an absolute HTTPS URL when NOTIFICATIONS_ENV=${env.NOTIFICATIONS_ENV}`);
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"].includes(hostname) || hostname.endsWith(".localhost")) {
    throw new Error(`EDGE_URL must be a non-local HTTPS service URL when NOTIFICATIONS_ENV=${env.NOTIFICATIONS_ENV}`);
  }
}
