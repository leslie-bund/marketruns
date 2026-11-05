# @market-runs/site — brand display site

Public brand site for Market Runs plus the domain-email receiver for the Smile ID lead pipeline.

- **Hono (Node)** server-rendered pages: landing, magic-link sign-in, admin inbox.
- **better-auth** magic links, sent via **Resend**, gated by the `ADMIN_EMAILS` allowlist (one admin for now).
- **Resend inbound webhook** at `POST /api/webhooks/resend` — Svix-signature verified, stores
  `email.received` events, fetches full bodies via the Resend receiving API.
- **Database**: local dev on `node:sqlite` (zero infra); production on Postgres via
  `SITE_DATABASE_URL` (Neon recommended). Tables auto-migrate at startup / cold start.

## Local development

```sh
npx pnpm install --filter @market-runs/site...
cp .env.example .env    # fill in RESEND_* and ADMIN_EMAILS
npm run dev             # http://localhost:8795 (accepts --port/--host, or PORT env)
npm test                # vitest
npm run typecheck
```

## Deploy to Vercel

Zero-config: Vercel detects the Hono app from the default export in `src/index.ts`.

1. Import the repo at [vercel.com/new](https://vercel.com/new) and set **Root Directory** to
   `apps/site` (Vercel detects pnpm and the Hono framework automatically).
2. Add the environment variables from `.env.example` (Production scope): `SITE_BASE_URL`
   (your final https domain), `BETTER_AUTH_SECRET`, `ADMIN_EMAILS`, `SITE_DATABASE_URL`,
   `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_WEBHOOK_SECRET`, `INBOUND_EMAIL_ADDRESS`.
3. Deploy. Then attach your domain in Vercel → Settings → Domains.

## Wire up Resend inbound email

1. Resend dashboard → Domains → add the same domain; publish the MX/SPF/DKIM records.
2. Create the inbound address (e.g. `hello@<domain>`).
3. Webhooks → add endpoint `https://<domain>/api/webhooks/resend`, subscribe to
   `email.received`, copy the signing secret into `RESEND_WEBHOOK_SECRET`, redeploy.
4. Submit the inbound address to the Smile ID lead collection pipeline — replies land in `/inbox`.
