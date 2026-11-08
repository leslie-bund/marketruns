import type { DatabaseEnv } from "./db.js";

export interface Env extends DatabaseEnv {
  /** Explicit deployed topology validation; unset/development/test keeps local URLs. */
  NOTIFICATIONS_ENV?: string;
  /** Shared edge ↔ notifications secret for durable reads and delivery callbacks. */
  NOTIFICATION_INTERNAL_TOKEN?: string;
  /** Explicit local header-auth demo only; deployed HTTP reads require the internal token. */
  ALLOW_HEADER_AUTH?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  /** Edge internal contact lookup and realtime delivery endpoints. */
  EDGE_URL?: string;
}
