import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export interface SiteEnv {
  port: number;
  host: string;
  baseUrl: string;
  authSecret: string;
  /** Postgres connection string (production/Vercel, e.g. Neon). When unset, local node:sqlite is used. */
  databaseUrl: string | undefined;
  databasePath: string;
  nodeEnv: string;
  resendApiKey: string | undefined;
  resendAudienceId?: string | undefined;
  resendWebhookSecret: string | undefined;
  /** From address for outgoing mail (magic links), on the Resend-verified domain. */
  resendFromEmail: string | undefined;
  /** The inbound address configured on the Resend domain (shown on the site). */
  inboundEmail: string;
  /** Lower-cased admin emails; only these receive magic links and can open the inbox. */
  adminEmails: string[];
}

function argValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === flag) return argv[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

/** Dev-only fallback: a random secret persisted under .data so watch-mode restarts keep sessions. */
function devSecret(databasePath: string): string {
  const secretPath = join(dirname(databasePath), "dev-secret");
  try {
    return readFileSync(secretPath, "utf8").trim();
  } catch {
    const generated = randomBytes(48).toString("base64");
    mkdirSync(dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, generated, { mode: 0o600 });
    console.warn("[site] BETTER_AUTH_SECRET unset — generated an ephemeral dev secret at", secretPath);
    return generated;
  }
}

export function isAdminEmail(env: SiteEnv, email: string): boolean {
  return env.adminEmails.includes(email.trim().toLowerCase());
}

export function loadEnv(): SiteEnv {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const port = Number(argValue("--port") ?? argValue("-p") ?? process.env.PORT ?? 8795);
  const host = argValue("--host") ?? process.env.HOST ?? "0.0.0.0";
  const databasePath = process.env.SITE_DATABASE_PATH ?? join(process.cwd(), ".data", "site.db");
  const configured = process.env.BETTER_AUTH_SECRET ?? "";
  const authSecret =
    configured.length >= 32
      ? configured
      : nodeEnv === "production"
        ? (() => {
            throw new Error("BETTER_AUTH_SECRET must be a random secret of at least 32 characters");
          })()
        : devSecret(databasePath);
  const adminEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  if (adminEmails.length === 0) {
    console.warn("[site] ADMIN_EMAILS unset — no one can sign in or read the inbox until it is configured");
  }
  return {
    port,
    host,
    baseUrl: (process.env.SITE_BASE_URL ?? `http://localhost:${port}`).trim().replace(/\/+$/, ""),
    authSecret,
    databaseUrl: process.env.SITE_DATABASE_URL || undefined,
    databasePath,
    nodeEnv,
    resendApiKey: process.env.RESEND_API_KEY || undefined,
    resendAudienceId: process.env.RESEND_AUDIENCE_ID || undefined,
    resendWebhookSecret: process.env.RESEND_WEBHOOK_SECRET || undefined,
    resendFromEmail: process.env.RESEND_FROM_EMAIL || undefined,
    inboundEmail: process.env.INBOUND_EMAIL_ADDRESS ?? "hello@market-runs.example",
    adminEmails,
  };
}
