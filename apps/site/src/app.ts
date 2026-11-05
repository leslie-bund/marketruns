import { Hono } from "hono";
import { createAuth, type SiteAuth } from "./auth.js";
import { listInboundEmails, type SiteDatabase } from "./db.js";
import { isAdminEmail, type SiteEnv } from "./env.js";
import { forbiddenPage, inboxPage, landingPage, signInPage } from "./pages.js";
import { handleResendWebhook } from "./webhooks/resend.js";

export interface SiteApp {
  app: Hono;
  auth: SiteAuth;
}

export function buildApp(env: SiteEnv, site: SiteDatabase): SiteApp {
  const auth = createAuth(env, site);
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, service: "market-runs-site" }));

  app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

  app.post("/api/webhooks/resend", async (c) => {
    const result = await handleResendWebhook(
      await c.req.text(),
      {
        "svix-id": c.req.header("svix-id"),
        "svix-timestamp": c.req.header("svix-timestamp"),
        "svix-signature": c.req.header("svix-signature"),
      },
      env,
      site,
    );
    return c.json(result.body, result.status);
  });

  async function currentUser(headers: Headers) {
    const session = await auth.api.getSession({ headers }).catch(() => null);
    return session?.user ?? null;
  }

  app.get("/", async (c) => {
    const user = await currentUser(new Headers(c.req.header()));
    return c.html(landingPage(env, user !== null && isAdminEmail(env, user.email)));
  });
  app.get("/sign-in", (c) => c.html(signInPage(env)));
  app.get("/sign-up", (c) => c.redirect("/sign-in"));

  app.get("/inbox", async (c) => {
    const user = await currentUser(new Headers(c.req.header()));
    if (!user) return c.redirect("/sign-in");
    if (!isAdminEmail(env, user.email)) return c.html(forbiddenPage(env, user.email), 403);
    return c.html(inboxPage(env, await listInboundEmails(site), user.email));
  });

  return { app, auth };
}
