import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import pg from "pg";
import type { DatabaseSync } from "node:sqlite";
import type { SiteEnv } from "./env.js";

// Vite (vitest) predates the node:sqlite builtin and fails to resolve a static import;
// loading it through createRequire keeps the real builtin at runtime in both tsx and vitest.
const { DatabaseSync: DatabaseSyncCtor } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSync;
};

/**
 * Local dev runs on node:sqlite (zero infra); production (Vercel) runs on Postgres
 * (Neon, per ADR-0010 the system of record) via SITE_DATABASE_URL.
 */
export type SiteDatabase =
  | { kind: "sqlite"; db: DatabaseSync }
  | { kind: "pg"; pool: pg.Pool };

export interface InboundEmailRow {
  id: string;
  event_type: string;
  resend_email_id: string | null;
  from_address: string;
  to_addresses: string;
  subject: string;
  text_body: string | null;
  html_body: string | null;
  raw_payload: string;
  received_at: string;
  created_at: string;
}

const INBOUND_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS inbound_emails (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    resend_email_id TEXT,
    from_address TEXT NOT NULL DEFAULT '',
    to_addresses TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL DEFAULT '',
    text_body TEXT,
    html_body TEXT,
    raw_payload TEXT NOT NULL DEFAULT '{}',
    received_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;

/** Opens the site database and guarantees the inbox table exists. Auth tables are created by better-auth migrations. */
export async function createSiteDatabase(env: SiteEnv): Promise<SiteDatabase> {
  if (env.databaseUrl) {
    const pool = new pg.Pool({ connectionString: env.databaseUrl });
    await pool.query(INBOUND_TABLE_DDL);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_inbound_emails_received_at ON inbound_emails (received_at DESC)`);
    return { kind: "pg", pool };
  }
  if (env.databasePath !== ":memory:") mkdirSync(dirname(env.databasePath), { recursive: true });
  const db = new DatabaseSyncCtor(env.databasePath);
  db.exec(INBOUND_TABLE_DDL);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inbound_emails_received_at ON inbound_emails (received_at DESC)`);
  return { kind: "sqlite", db };
}

export async function insertInboundEmail(
  site: SiteDatabase,
  row: Omit<InboundEmailRow, "created_at"> & { created_at?: string },
): Promise<void> {
  const createdAt = row.created_at ?? new Date().toISOString();
  const values = [
    row.id,
    row.event_type,
    row.resend_email_id,
    row.from_address,
    row.to_addresses,
    row.subject,
    row.text_body,
    row.html_body,
    row.raw_payload,
    row.received_at,
    createdAt,
  ];
  if (site.kind === "pg") {
    await site.pool.query(
      `INSERT INTO inbound_emails (id, event_type, resend_email_id, from_address, to_addresses, subject, text_body, html_body, raw_payload, received_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      values,
    );
    return;
  }
  site.db
    .prepare(
      `INSERT INTO inbound_emails (id, event_type, resend_email_id, from_address, to_addresses, subject, text_body, html_body, raw_payload, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...(values as [string, string, string | null, string, string, string, string | null, string | null, string, string, string]));
}

export async function listInboundEmails(site: SiteDatabase, limit = 100): Promise<InboundEmailRow[]> {
  if (site.kind === "pg") {
    const result = await site.pool.query(`SELECT * FROM inbound_emails ORDER BY received_at DESC LIMIT $1`, [limit]);
    return result.rows as InboundEmailRow[];
  }
  return site.db
    .prepare(`SELECT * FROM inbound_emails ORDER BY received_at DESC LIMIT ?`)
    .all(limit) as unknown as InboundEmailRow[];
}
