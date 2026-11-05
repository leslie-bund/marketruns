import { Hono } from "hono";
import { pathToFileURL } from "node:url";
import { buildApp, type SiteApp } from "./app.js";
import { migrateAuth } from "./auth.js";
import { createSiteDatabase } from "./db.js";
import { loadEnv } from "./env.js";

let appPromise: Promise<SiteApp> | undefined;

/**
 * Lazily builds the app and runs migrations once per process — on Vercel that means once
 * per cold start; migration races between concurrent cold starts are tolerated and logged.
 */
export function getApp(): Promise<SiteApp> {
  appPromise ??= (async () => {
    const env = loadEnv();
    const site = await createSiteDatabase(env);
    const built = buildApp(env, site);
    try {
      await migrateAuth(built.auth);
    } catch (error) {
      console.warn("[site] auth migration failed (continuing):", error instanceof Error ? error.message : error);
    }
    return built;
  })();
  return appPromise;
}

/** Default export: Vercel detects and serves this Hono app with zero configuration. */
const app = new Hono();
app.all("*", async (c) => (await getApp()).app.fetch(c.req.raw));
export default app;

// Local development: `npm run dev` runs this file directly and starts a real listener.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { serve } = await import("@hono/node-server");
  const env = loadEnv();
  await getApp();
  serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
    console.log(`[site] market-runs listening on http://localhost:${info.port}`);
    console.log(`[site] resend inbound webhook: POST ${env.baseUrl}/api/webhooks/resend`);
    if (!env.resendWebhookSecret) {
      console.warn("[site] RESEND_WEBHOOK_SECRET unset — inbound email storage is disabled (503) until configured");
    }
    if (!env.resendApiKey || !env.resendFromEmail) {
      console.warn("[site] RESEND_API_KEY / RESEND_FROM_EMAIL unset — magic links will be logged, not sent");
    }
  });
}
