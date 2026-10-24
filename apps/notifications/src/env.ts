import type { DatabaseEnv } from "./db.js";

export interface Env extends DatabaseEnv {
  NOTIFICATION_INTERNAL_TOKEN?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  /** Identity-owned contact directory; never accepts an email address from a client. */
  IDENTITY_URL?: string;
  IDENTITY_INTERNAL_TOKEN?: string;
  /** Edge internal realtime delivery endpoint. */
  EDGE_URL?: string;
}
