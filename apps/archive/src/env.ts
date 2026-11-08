import type { DatabaseEnv } from "./db.js";

/** Archive worker bindings (infra/wrangler.archive.toml). */
export interface Env extends DatabaseEnv {
  /** Explicit deployed posture validation; unset/development/test keeps local behavior. */
  ARCHIVE_ENV?: string;
  /** Retirement snapshots that have no Postgres table (carts) land here (ADR-0010). */
  ARCHIVE_BUCKET?: R2Bucket;
  /** Canonical settlement execution requests, emitted only after archive commit. */
  PAYMENT_QUEUE: Queue;
  /** Post-persist lifecycle sink; queue redelivery is deduped by source event id. */
  NOTIFICATION_QUEUE?: Queue;
  /** Shared edge → archive secret for reputation and all admin read routes. */
  ARCHIVE_INTERNAL_TOKEN?: string;
  /** Explicit local header-auth demo only; deployed reads require the internal token. */
  ALLOW_HEADER_AUTH?: string;
}
