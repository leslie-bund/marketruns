import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAuth, migrateAuth, type SiteAuth } from "./auth";
import { createSiteDatabase, type SiteDatabase } from "./db";
import { isAdminEmail, loadEnv, type SiteEnv } from "./env";

export interface SiteContext {
  env: SiteEnv;
  site: SiteDatabase;
  auth: SiteAuth;
}

let contextPromise: Promise<SiteContext> | undefined;

export function getSite(): Promise<SiteContext> {
  contextPromise ??= (async () => {
    const env = loadEnv();
    const site = await createSiteDatabase(env);
    const auth = createAuth(env, site);
    try {
      await migrateAuth(auth);
    } catch (error) {
      console.warn("[site] auth migration failed (continuing):", error instanceof Error ? error.message : error);
    }
    return { env, site, auth };
  })();
  return contextPromise;
}

export async function getSessionContext() {
  const context = await getSite();
  const session = await context.auth.api
    .getSession({ headers: await headers() })
    .catch(() => null);
  return { ...context, user: session?.user ?? null };
}

export async function requireAdmin() {
  const context = await getSessionContext();
  if (!context.user) redirect("/sign-in");
  if (!isAdminEmail(context.env, context.user.email)) redirect("/forbidden");
  return { ...context, user: context.user };
}
