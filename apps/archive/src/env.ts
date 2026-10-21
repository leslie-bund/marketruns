import type { DatabaseEnv } from "./db.js";

/** Archive worker bindings (infra/wrangler.archive.toml). */
export interface Env extends DatabaseEnv {
  /** Retirement snapshots that have no Postgres table (carts) land here (ADR-0010). */
  ARCHIVE_BUCKET?: R2Bucket;
}
