# @market-runs/site — brand site and email portal

Next.js 16 marketing site, early-access registration, and private admin email portal for Market Runs.

- **Marketing:** responsive product pages and early-access registration with explicit email consent.
- **Registration:** Postgres persistence through Drizzle ORM, Resend Audience contact sync, and React Email confirmation messages.
- **Admin:** Better Auth magic links restricted by `ADMIN_EMAILS`; visitor registrations, a threaded inbound inbox, and rich-text replies through Resend.
- **Resend inbound:** `POST /api/webhooks/resend` verifies Svix signatures and fetches full message bodies. Use the configured inbound address on the Smile ID application; replies arrive in the admin inbox.
- **Database:** local development uses `node:sqlite`; production uses Postgres through `SITE_DATABASE_URL`. Site tables auto-migrate at startup/cold start.

## Local development

```sh
npx pnpm install --filter @market-runs/site...
cp .env.example .env    # fill in auth and Resend settings
npm run dev             # http://localhost:8795
npm test
npm run typecheck
npm run build
```

Preview React Email templates with `pnpm exec email dev --dir emails --port 3001`.

## Deploy to Vercel

Set **Root Directory** to `apps/site`. Vercel detects Next.js and runs `next build`. Add the environment variables from `.env.example` (Production scope), including `RESEND_AUDIENCE_ID` when Audience syncing is enabled. The Resend API key needs sending and contact permissions.

Attach the domain in Vercel → Settings → Domains and set `SITE_BASE_URL` to the final HTTPS origin.

## Resend and Smile ID workflow

1. Verify the domain in Resend and publish its MX/SPF/DKIM records.
2. Configure the inbound address and a webhook for `email.received` pointing to `https://<domain>/api/webhooks/resend`.
3. Set `RESEND_WEBHOOK_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and `INBOUND_EMAIL_ADDRESS`.
4. For early-access contacts, set `RESEND_AUDIENCE_ID` and create the string contact property `interest` in Resend if it does not already exist.
5. Submit the inbound address through Smile ID's own lead application. Their replies appear at `/admin/inbox`; admins can reply in the same thread.
