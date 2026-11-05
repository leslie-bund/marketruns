import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { isAdminEmail, type SiteEnv } from "./env";
import { sendMagicLinkEmail } from "./mailer";
import type { SiteDatabase } from "./db";

export type SiteAuth = ReturnType<typeof createAuth>;

/**
 * Better Auth scoped to this display site only — unrelated to the participant identity seam
 * in apps/edge. Sign-in is magic-link-only; links are sent via Resend and only to ADMIN_EMAILS.
 */
export function createAuth(env: SiteEnv, site: SiteDatabase) {
  return betterAuth({
    appName: "Market Runs",
    baseURL: env.baseUrl,
    basePath: "/api/auth",
    secret: env.authSecret,
    database: site.kind === "pg" ? site.pool : site.db,
    session: { expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
    advanced: { useSecureCookies: env.nodeEnv === "production" },
    plugins: [
      magicLink({
        expiresIn: 10 * 60,
        sendMagicLink: async ({ email, url }) => {
          // One-admin policy: never send a sign-in link to a non-admin address.
          // The request still answers 200 so the allowlist cannot be probed.
          if (!isAdminEmail(env, email)) {
            console.warn("[site] magic link suppressed for non-admin email");
            return;
          }
          await sendMagicLinkEmail(env, email, url);
        },
      }),
    ],
  });
}

/** Creates/updates the better-auth core tables (user, session, account, verification) in the site database. */
export async function migrateAuth(auth: SiteAuth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}
