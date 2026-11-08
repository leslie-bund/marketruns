import type { Env } from "./env.js";
import { headerAuthAllowed } from "../registry/index.js";

export type PaymentsAuthEnv = Pick<Env, "PAYMENTS_INTERNAL_TOKEN" | "ALLOW_HEADER_AUTH">;

/** Deployed calls require service auth; the explicit header-auth demo retains the tokenless local posture. */
export function paymentsAuthConfigured(env: PaymentsAuthEnv): boolean {
  return Boolean(env.PAYMENTS_INTERNAL_TOKEN) || headerAuthAllowed(env);
}

/** Build upstream headers from trusted edge state, adding service auth whenever it is configured. */
export function paymentsServiceHeaders(env: PaymentsAuthEnv, init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (env.PAYMENTS_INTERNAL_TOKEN) headers.set("x-payments-internal", env.PAYMENTS_INTERNAL_TOKEN);
  return headers;
}
