import type { DatabaseEnv } from "./db.js";

/** Payments worker bindings (infra/wrangler.payments.toml). */
export interface Env extends DatabaseEnv {
  /**
   * Which PaymentDispatcher moves the money ("stub" is the dev default).
   * Vendor selection strings and vendor config keys (secret key, webhook
   * hash, base URL) are defined ONLY in the dispatcher module and its vendor
   * quarantine folder (ADR-0009); they arrive here as plain env entries and
   * are validated there.
   */
  PAYMENT_DISPATCHER?: string;
  /** Shared edge → payments secret required for payout-account management. */
  PAYMENTS_INTERNAL_TOKEN?: string;
  /** Explicit local demo only; deployed payout auth requires the internal token. */
  ALLOW_HEADER_AUTH?: string;
  NOTIFICATION_QUEUE?: Queue;
}
