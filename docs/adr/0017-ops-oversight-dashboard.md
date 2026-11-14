# The ops console graduates into an oversight dashboard, with a live-run index and the zone portal pulled forward

ADR-0014 shipped a minimal ops console whose reads came only from Durable Objects. That works for steering one live market, but not for oversight: DOs are unlistable, so there was no way to answer "what ran this week", "what is disputed", or "are we passing the ADR-0013 expansion gate" without holding every live object in your head. This ADR records the read model that closes that gap, the index that makes live runs enumerable, the interpretation choices the ops-health gate required, and the auth and design decisions that came with it.

## Historical reads come from Postgres; live reads stay in DOs; DOs are never enumerated

The dashboard splits its reads by durability, matching ADR-0010's state mapping. **Historical and aggregate oversight reads come from Postgres** through new archive-worker endpoints: `GET /admin/runs` (a union of the new `live_runs` table and `runs_archive`), `/admin/disputes`, `/admin/settlements`, `/admin/ledger`, and `/admin/ops-health`. **Live state still comes from the DOs** through the edge's existing `/ops/api/*` routes. Durable Objects are never enumerated: there is no list operation and none is simulated. Anything the dashboard lists lives in Postgres first.

The edge fronts the archive endpoints with five fail-closed proxies (`/ops/api/admin/*`): every response is validated against the zod admin schemas (`packages/proto/src/admin.ts`), an unreachable archive returns 503, and a response that fails validation returns 502. The dashboard never renders unvalidated data.

## The live-run index

Because DOs cannot be listed, a `live_runs` Postgres table (migration `0002_workable_valkyrie`) indexes runs in flight. CartDO emits a new `run.started` archive-queue message at checkout; `run.retired` and `settlement.released` mark the row retired. The index stores only `runId`, `market`, `status`, `runnerId`, `buyerId`, `startedAt`, `retiredAt`, and `stopCount` — detail still comes from the RunDO.

The send is **fire-and-forget**: a queue-send failure only `console.error`s, the same durability posture as retirement sends. The accepted consequence is that a lost `run.started` leaves no row (the run still appears in `runs_archive` at retirement, so history is complete), and a lost retirement marker leaves a row stale until a later event closes it. Oversight tolerates both; money never depends on the index.

## The ops-health gate, interpreted

`computeOpsHealth` (`packages/domain/src/ops-health.ts`) is a pure function computing the five ADR-0013 expansion-gate metrics — 8 consecutive qualifying weeks, 500 completed runs, <5% dispute rate, ≥60% zero-touch, ≥30 repeat buyers — with rates in basis points, matching reputation. ADR-0013 left "qualifying week" undefined; the documented choices, relied on by `/admin/ops-health`:

- A week is a UTC Monday-aligned 7-day bucket over `runs_archive.closed_at`, and qualifies when it has at least one closed run, a dispute rate strictly below 500 bps, and a zero-touch rate at or above 6 000 bps that week. An empty week demonstrates nothing and breaks the streak.
- "Zero ops intervention" is proxied by the absence of disputes and ops-settled (`mode === "disputed"`) records — the durable record carries no explicit flag, and a disputed settlement is the only close that requires human ops action.
- `completedRuns` and `repeatBuyers` are cumulative over the whole market history, not per-week.

## Auth and the token contract

The dashboard is ops-only, and the gate hardened with it: MarketDO `POST /config` now sits behind `requireOps()`, and `GET /ops` itself requires the ops token when `OPS_TOKEN` is set — as a `?token=` query parameter **for page entry only** (a browser needs a way in), after which the page calls the API with the `x-ops-token` header. The API accepts the header only. With `OPS_TOKEN` unset, local dev still admits a clearly labelled `local-ops` operator (ADR-0015's posture unchanged).

The zone admin portal ADR-0016 deferred to v2 ships now, by explicit owner decision: `GET/POST /ops/api/markets` and `POST /ops/api/markets/:market/config`, with zone names validated at 1–64 characters of letters, digits, spaces, and `._-`. **This supersedes ADR-0016's deferral of the zone portal.**

## The dedicated app becomes the only operator HTML surface

The embedded console established the shared paper/white/ink/green/lime design language and the operational API boundaries. Its scripted demo driver was removed first; the redundant embedded HTML and login page were subsequently retired once the dedicated app became the supported interface. The authenticated JSON API and its settlement safeguards remain on edge.

The dedicated operator web app lives in `apps/ops` (React + Vite). It uses the same edge Better Auth database, sessions, roles, and `/ops/api/*` authorization rather than creating a second identity system. Its Worker serves the static build and proxies same-origin `/ops/*` calls to the edge through a staging service binding; `run_worker_first` prevents SPA fallback from intercepting those API calls. Existing operators can sign in with ten-minute single-use magic links delivered through Resend; public sign-up remains disabled. The Worker rewrites Better Auth verification redirects back to the dedicated dashboard origin, and `ops.marketruns.org` is configured as its Cloudflare Custom Domain.

The Archive page also exposes durable archive-consumer receipts through `/ops/api/admin/archive-queue`: received, persisted, retrying, and rejected messages, with attempts, errors, and oldest unresolved receipt. This is operational consumer history, not a claim that a Worker can query Cloudflare's internal queue backlog. Market inspection displays the floor-rate formula `ceil(base + distanceKm × perKm + durationMin × perMinute)` and computes the configured fallback-route example.

Market onboarding is available to operators and administrators in that dedicated app. A Leaflet/OpenStreetMap picker sets the market center by map click, marker drag, or keyboard-accessible coordinates; a numeric field and slider control the geofence radius. Submission uses the existing authenticated `POST /ops/api/markets` contract and its audited MarketDO/Postgres write path, not a second onboarding mechanism. New markets retain the registry's launch hours, rates, and settlement defaults, with empty exchange and muster point lists until those are configured. The map retains OpenStreetMap attribution; coordinate entry remains available when tiles cannot load.

The dedicated app now exposes the complete operator workflow rather than only the market catalogue: overview and expansion health, live runs and handoff evidence, disputes and admin settlement decisions, settlement and ledger records, dispatches, holds, refunds and grouped recovery, markets and vocabulary, stores and catalogs, runner pools, participant involvement and reputation, archive history, audit events, explicit object telemetry with bounded event observation, and final device-reset decisions each have a dedicated surface. These pages compose the existing authenticated reads and writes; they introduce no new money path, no Durable Object enumeration, and no client-supplied settlement legs.

## Consequences

- The ADR-0013 expansion gate is now measurable from the durable record alone; the interpretation choices above are the definition until ADR-0013 is amended.
- Oversight never touches a DO it doesn't have to; the archive worker is the only read path for history.
- `run.started` joins the archive contract (`packages/proto/src/archive.ts`); archive redelivery stays idempotent.
- When participant auth ships, the dashboard's token contract is unaffected — `requireOps` remains the single gate.
