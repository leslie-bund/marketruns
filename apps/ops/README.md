# Market Runs Ops

Dedicated operator web app for live market oversight. It uses the edge's existing Better Auth accounts, sessions, roles, and `/ops/api/*` authorization; it does not maintain a second identity system.

## Operational workflows

The app provides dedicated, role-gated pages for the operations overview, live and archived runs, dispute evidence and settlement decisions, settlement records, the double-entry ledger, payment dispatches, buyer holds, refunds and recovery, market configuration and vocabulary, stores and catalogs, runner-pool membership, participant involvement and reputation, archived records, append-only operator audit events, Durable Object telemetry and live event observation, and final device-reset decisions.

List filters and inspectors use the existing authenticated edge reads. Administrative writes use the existing audited endpoints; settlement remains the only money decision, and the app never creates ad-hoc transfers or edits ledger entries. Empty, loading, and failed read states are shown explicitly rather than replaced with demo data.

## Local development

From the repository root:

```bash
pnpm --filter @market-runs/ops install
pnpm --filter @market-runs/ops dev
```

The app listens on port `7100`. Create `apps/ops/.env.local` with `OPS_EDGE_URL` pointing at the edge environment to use. If unset, Vite proxies to `http://localhost:8787`.

```text
OPS_EDGE_URL=https://market-runs-edge-staging.leslie-bund.workers.dev
```

Use an operator account provisioned through the controlled ops CLI. The staging administrator is `founder@marketruns.org`; its password is read from the local staging secrets and must not be committed.

## Admin magic links

Existing admins can choose **Email me a sign-in link** instead of using a password. Better Auth creates a ten-minute, single-use token; edge delivers it through Resend only when the address belongs to an existing ops admin. Unknown addresses, viewers, and operators receive the same generic UI response without an email, and magic-link self-registration is disabled. A redeemed link proves email ownership and supersedes the bootstrap-password change gate.

Set `RESEND_API_KEY` as an edge secret, `RESEND_FROM_EMAIL` to the verified sender, and `OPS_DASHBOARD_URL` to the public dedicated-app origin. The sender and key must also remain configured on notifications for participant delivery. The dedicated Worker rewrites Better Auth's verification redirect back to its own origin.

## Market onboarding

Operators and administrators can choose **Onboard market** to create a market through the existing authenticated `POST /ops/api/markets` route. Click the map or drag its marker to set the center, then use the numeric field or slider to set the geofence radius. Latitude and longitude inputs provide a keyboard-accessible alternative and remain usable if map tiles are unavailable. New markets use the registry's 08:00–18:00 hours, an eight-hour close window, and the existing launch rate and settlement defaults; exchange and muster points start empty.

The map uses Leaflet with OpenStreetMap tiles and retains the required OpenStreetMap attribution. Loading the interactive map therefore requires network access to the public OpenStreetMap tile service.

## Checks

```bash
pnpm --filter @market-runs/ops typecheck
pnpm --filter @market-runs/ops lint
pnpm --filter @market-runs/ops build
```

## Deployment

The Worker serves the static React build and proxies `/ops/*` to `EDGE_ORIGIN`, keeping Better Auth cookies same-origin. The Vite development server provides the equivalent local proxy. Staging uses a Cloudflare service binding to `market-runs-edge-staging`; Worker-to-Worker HTTP fetches over the same account's `workers.dev` hostnames are not supported. `run_worker_first` ensures the SPA fallback cannot intercept API requests.

```bash
pnpm --filter @market-runs/ops build
pnpm exec wrangler deploy --config apps/ops/wrangler.toml --env staging
```

The staging target is `market-runs-ops-staging`, with `ops.marketruns.org` configured as a Cloudflare Custom Domain and `workers_dev = true` retaining the preview hostname. Cloudflare creates the DNS record and certificate automatically when `marketruns.org` is an active zone in the same account. If the domain is registered elsewhere, first add the zone to Cloudflare and delegate its nameservers; do not manually CNAME the hostname to `workers.dev`. The old embedded edge console has been removed.
