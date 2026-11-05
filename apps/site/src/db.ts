import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { asc, desc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { index, pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import type { DatabaseSync } from "node:sqlite";
import type { SiteEnv } from "./env";

// Vite (vitest) predates the node:sqlite builtin and fails to resolve a static import;
// loading it through createRequire keeps the real builtin at runtime in both tsx and vitest.
const { DatabaseSync: DatabaseSyncCtor } = createRequire(`${process.cwd()}/package.json`)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSync;
};

export const inboundEmails = pgTable(
  "inbound_emails",
  {
    id: text("id").primaryKey(),
    event_type: text("event_type").notNull(),
    resend_email_id: text("resend_email_id"),
    from_address: text("from_address").notNull().default(""),
    to_addresses: text("to_addresses").notNull().default("[]"),
    subject: text("subject").notNull().default(""),
    text_body: text("text_body"),
    html_body: text("html_body"),
    raw_payload: text("raw_payload").notNull().default("{}"),
    received_at: text("received_at").notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => [index("idx_inbound_emails_received_at").on(table.received_at)],
);

export const emailReplies = pgTable(
  "email_replies",
  {
    id: text("id").primaryKey(),
    inbound_email_id: text("inbound_email_id")
      .notNull()
      .references(() => inboundEmails.id),
    to_address: text("to_address").notNull(),
    subject: text("subject").notNull(),
    text_body: text("text_body").notNull(),
    html_body: text("html_body").notNull(),
    status: text("status", { enum: ["sent", "failed"] }).notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => [index("idx_email_replies_inbound").on(table.inbound_email_id, table.created_at)],
);

export const leadRegistrations = pgTable("lead_registrations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  interest: text("interest", { enum: ["buyer", "seller", "runner", "partner"] }).notNull(),
  message: text("message").notNull().default(""),
  confirmation_sent: text("confirmation_sent", { enum: ["sent", "failed"] }).notNull(),
  created_at: text("created_at").notNull(),
});

const schema = { inboundEmails, emailReplies, leadRegistrations };

export type SiteDatabase =
  | { kind: "sqlite"; db: DatabaseSync }
  | { kind: "pg"; pool: pg.Pool; db: NodePgDatabase<typeof schema> };

export type InboundEmailRow = typeof inboundEmails.$inferSelect;
export type EmailReplyRow = typeof emailReplies.$inferSelect;
export type LeadRegistrationRow = typeof leadRegistrations.$inferSelect;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS inbound_emails (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inbound_emails_received_at ON inbound_emails (received_at DESC)`,
  `CREATE TABLE IF NOT EXISTS email_replies (
    id TEXT PRIMARY KEY,
    inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id),
    to_address TEXT NOT NULL,
    subject TEXT NOT NULL,
    text_body TEXT NOT NULL,
    html_body TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_email_replies_inbound ON email_replies (inbound_email_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS lead_registrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    interest TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    confirmation_sent TEXT NOT NULL CHECK (confirmation_sent IN ('sent', 'failed')),
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_lead_registrations_created_at ON lead_registrations (created_at DESC)`,
];

export async function createSiteDatabase(env: SiteEnv): Promise<SiteDatabase> {
  if (env.databaseUrl) {
    const pool = new pg.Pool({ connectionString: env.databaseUrl });
    for (const statement of SCHEMA_STATEMENTS) await pool.query(statement);
    return { kind: "pg", pool, db: drizzle(pool, { schema }) };
  }
  if (env.databasePath !== ":memory:") mkdirSync(dirname(env.databasePath), { recursive: true });
  const db = new DatabaseSyncCtor(env.databasePath);
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
  return { kind: "sqlite", db };
}

export async function insertInboundEmail(
  site: SiteDatabase,
  row: Omit<InboundEmailRow, "created_at"> & { created_at?: string },
): Promise<void> {
  const values = { ...row, created_at: row.created_at ?? new Date().toISOString() };
  if (site.kind === "pg") {
    await site.db.insert(inboundEmails).values(values);
    return;
  }
  site.db
    .prepare(
      `INSERT INTO inbound_emails (id, event_type, resend_email_id, from_address, to_addresses, subject, text_body, html_body, raw_payload, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      values.id,
      values.event_type,
      values.resend_email_id,
      values.from_address,
      values.to_addresses,
      values.subject,
      values.text_body,
      values.html_body,
      values.raw_payload,
      values.received_at,
      values.created_at,
    );
}

export async function listInboundEmails(site: SiteDatabase, limit = 100): Promise<InboundEmailRow[]> {
  if (site.kind === "pg") {
    return site.db.select().from(inboundEmails).orderBy(desc(inboundEmails.received_at)).limit(limit);
  }
  return site.db
    .prepare(`SELECT * FROM inbound_emails ORDER BY received_at DESC LIMIT ?`)
    .all(limit) as unknown as InboundEmailRow[];
}

export async function getInboundEmail(site: SiteDatabase, id: string): Promise<InboundEmailRow | undefined> {
  if (site.kind === "pg") {
    const rows = await site.db.select().from(inboundEmails).where(eq(inboundEmails.id, id)).limit(1);
    return rows[0];
  }
  return site.db.prepare(`SELECT * FROM inbound_emails WHERE id = ?`).get(id) as unknown as
    | InboundEmailRow
    | undefined;
}

export async function recordEmailReply(site: SiteDatabase, row: EmailReplyRow): Promise<void> {
  if (site.kind === "pg") {
    await site.db.insert(emailReplies).values(row);
    return;
  }
  site.db
    .prepare(
      `INSERT INTO email_replies (id, inbound_email_id, to_address, subject, text_body, html_body, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.inbound_email_id, row.to_address, row.subject, row.text_body, row.html_body, row.status, row.created_at);
}

export async function listEmailReplies(site: SiteDatabase, inboundEmailId: string): Promise<EmailReplyRow[]> {
  if (site.kind === "pg") {
    return site.db
      .select()
      .from(emailReplies)
      .where(eq(emailReplies.inbound_email_id, inboundEmailId))
      .orderBy(asc(emailReplies.created_at));
  }
  return site.db
    .prepare(`SELECT * FROM email_replies WHERE inbound_email_id = ? ORDER BY created_at ASC`)
    .all(inboundEmailId) as unknown as EmailReplyRow[];
}

export async function recordLeadRegistration(site: SiteDatabase, row: LeadRegistrationRow): Promise<void> {
  if (site.kind === "pg") {
    await site.db.insert(leadRegistrations).values(row);
    return;
  }
  site.db
    .prepare(
      `INSERT INTO lead_registrations (id, name, email, interest, message, confirmation_sent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.name, row.email, row.interest, row.message, row.confirmation_sent, row.created_at);
}

export async function listLeadRegistrations(site: SiteDatabase, limit = 100): Promise<LeadRegistrationRow[]> {
  if (site.kind === "pg") {
    return site.db.select().from(leadRegistrations).orderBy(desc(leadRegistrations.created_at)).limit(limit);
  }
  return site.db
    .prepare(`SELECT * FROM lead_registrations ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as unknown as LeadRegistrationRow[];
}
