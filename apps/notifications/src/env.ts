import type { DatabaseEnv } from "./db.js";

export interface Env extends DatabaseEnv {
  NOTIFICATION_INTERNAL_TOKEN?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  /** Edge internal contact lookup and realtime delivery endpoints. */
  EDGE_URL?: string;
}
