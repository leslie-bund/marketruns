# Infrastructure

First real-human test session? Follow `docs/runbooks/first-live-test.md` — it builds on everything below.

Repeatable staging setup? Run `bash infra/staging-setup.sh`, then verify with `bash infra/staging-check.sh`. The full provisioning, archive-first deployment, paid configuration, reconciliation, and rollback procedure is `docs/runbooks/staging-deployment.md`. SmileID and OSRM remain outside that staging batch.

Provision the Cloudflare resources referenced by the Wrangler configurations before deployment. Store credentials with `wrangler secret put`; never commit `.env`, `.dev.vars`, the Neon connection string, payment credentials, or identity verification credentials. Hyperdrive is configured out of band and must not contain a committed connection string.

For hybrid identity, create `market-runs-identity-captures` (and the preview bucket for deployed previews) with `wrangler r2 bucket create`, keep public access/custom public domains disabled, and restrict access to the identity Worker. Do not place enrollment captures in the marketplace evidence bucket. Apply migration `0015` before enabling hybrid enrollment. Account-deletion propagation for the retained current selfie remains a required follow-up; see ADR-0028 rather than assuming an endpoint exists.

## One-command demo stack (recommended)

```bash
npx pnpm@9.15.4 dev:all          # local: postgres + migrations + edge + archive + demo seed
npx pnpm@9.15.4 dev:all -- --tunnel   # + Cloudflare quick tunnel for friends' phones
npx pnpm@9.15.4 dev:all -- --no-seed  # skip the demo seed
```

`infra/dev-all.sh` (what `dev:all` runs) does, in order:

1. **Postgres** — starts the `market-runs-postgres` docker container (`postgres:16-alpine` on `:54322`) if needed, reuses it if already running, and waits for `pg_isready`.
2. **Migrations** — `drizzle-kit migrate` in `infra/drizzle` with `DATABASE_URL` (default `postgres://postgres:postgres@localhost:54322/market_runs`). Logs to `.dev-logs/migrate.log`.
3. **Core markets** — `node infra/seed-core.mjs` upserts Balogun and Computer Village immediately after migrations. This is required before store registration and repairs an existing dev database without deleting data; it runs even with `--no-seed`.
4. **Biometrics (hybrid only) + edge + archive + identity + payments + notifications** — delegates to `infra/dev-servers.sh` (biometrics on loopback `:8792` before hybrid identity; edge on `:8787`, archive on `:8788`, identity on `:8789`, payments on `:8790`, notifications on `:8791`, health checks, logs in `.dev-logs/`). The edge receives explicit local `DATABASE_URL`, `PAYMENTS_REQUIRED`, and `ALLOW_HEADER_AUTH=true` values.
5. **Demo seed** (default on) — `infra/seed-demo.mjs` registers two Balogun stores (Amina's Fresh Store, Mama Ngozi Provisions) and one Computer Village store (Emeka Phones & Accessories) over the real `POST /command` wire, so a fresh backend has a market vocabulary buyers can post intents against. It uses deterministic store ids — re-running is a no-op.
6. **`--tunnel`** — runs `cloudflared tunnel --url http://localhost:8787`, captures the `*.trycloudflare.com` URL, and prints a summary box: the tunnel URL, the exact `EXPO_PUBLIC_EDGE_URL=…` line for `apps/mobile/.env`, the guarded `/ops?token=…` console link, and the friend-side step (`npx expo start --tunnel`, which needs `@expo/ngrok`). Without `cloudflared` installed it prints `brew install cloudflared` and continues LAN-only.

Ctrl-C stops everything the script started — the tunnel, all worker processes, and the Postgres container **only if the script started it** (a container you left running stays running; container data persists either way). Hybrid biometrics follows the same ownership rule: a healthy pre-existing loopback service is reused and left running, while only a container started by the dev scripts is stopped.

### Real local services (normal development)

A normal real-service `dev:all` run is driven by `infra/.dev.vars`; it does not force the test stubs. Keep this file gitignored and never print or commit its values. Explicit shell values win over the file for the orchestration switches.

For **Flutterwave test payments**, set:

```dotenv
PAYMENT_DISPATCHER=flutterwave
FLUTTERWAVE_SECRET_KEY=<your FLWSECK_TEST- secret>
# Optional one-minute mock-transfer accelerator; test keys only:
FLUTTERWAVE_TEST_MODE=1
```

The accelerator is rejected at configuration time with any key that does not start `FLWSECK_TEST-`, including a live key. Leave `PAYMENTS_REQUIRED` unset/empty for unpaid local checkout, or set it explicitly only when rehearsing funded checkout with the corresponding payment setup.

For **hybrid identity**, all of the following are required before identity will pass its local runtime validation:

```dotenv
FACE_VERIFIER=hybrid
BIOMETRIC_MODEL_DIR=<absolute directory containing both ONNX models>
BIOMETRICS_SERVICE_URL=http://127.0.0.1:8792
BIOMETRICS_SERVICE_TOKEN=<random 32+ character private token>
SMILEID_PARTNER_ID=<sandbox partner id>
SMILEID_API_KEY=<sandbox api key>
SMILEID_ENV=sandbox
EDGE_URL=http://127.0.0.1:8787
IDENTITY_INTERNAL_TOKEN=<shared edge/identity internal token>
SMILEID_PRIVACY_NOTICE_URL=<public non-example HTTPS privacy notice>
```

`BIOMETRIC_MODEL_DIR` must contain `w600k_r50.onnx` and `MiniFASNetV2.onnx`; model artifacts are not committed. Compose mounts it read-only, maps `BIOMETRICS_SERVICE_TOKEN` to the container's `BIOMETRICS_INTERNAL_TOKEN`, and publishes biometrics only at `127.0.0.1:8792` (container port 8791). Notifications remains on host port 8791. The dev scripts build/start biometrics before identity and wait for health. A missing directory, model, or token is a hard startup error — there is no silent stub fallback.

The local `IDENTITY_CAPTURES` R2 binding from `infra/wrangler.identity.toml` must remain present; captures are private and must not use a public bucket domain. `EDGE_URL` and `IDENTITY_INTERNAL_TOKEN` are mandatory because successful enrollment reconciles KYC with core. The privacy notice must be a real, non-local HTTPS URL, not the `example.com` development placeholder. Loopback HTTP is permitted only for local biometrics/edge service URLs; remote HTTP and deployed loopback biometrics are rejected. `SMILEID_CALLBACK_URL` may use the partner dashboard default locally; when supplied for device callbacks, use the real public HTTPS edge callback. For a real-human session, also provision non-development identity encryption/session secrets as described below rather than relying on committed local fallbacks.

The legacy-supported `FACE_VERIFIER=smileid` selector receives the same validation and biometrics lifecycle, but `hybrid` is the normal target. `FACE_VERIFIER=stub` and an empty local environment remain available only as explicit isolated test fixtures.

### Hermetic stack rehearsal

`pnpm test:stack` is deliberately different from normal development. For its temporary database and worker lifecycle only, it forces `PAYMENT_DISPATCHER=stub`, `FACE_VERIFIER=stub`, and unpaid checkout, forwarding those selectors explicitly so a real `infra/.dev.vars` cannot override them. It also blanks the Flutterwave key/test accelerator in the child environment, preventing `e2e-session` and `reconcile` from reloading local credentials or making provider reconciliation reads. It does not build/start biometrics and never calls Smile ID or Flutterwave. These overrides end with the rehearsal; the next ordinary `dev:all` again uses the real local configuration.

### Ops authentication and the tunnel

Deployed ops uses Better Auth through the dedicated `apps/ops` dashboard. Only the allow-listed `/ops/auth` endpoints are public on edge; every `/ops/api` route remains protected, and edge serves no HTML login or console. Existing admins may use Resend-delivered magic links. Local development may instead use the explicit legacy identity for API automation when both `OPS_LOCAL_DEV=true` and `OPS_LEGACY_DEV=true`; that path is never inferred in a deployed environment.

With `--tunnel`, a random legacy `OPS_TOKEN` is generated when unset and printed in the summary box; a set-but-short token (< 16 chars) triggers a loud warning. Without `--tunnel`, the token stays optional in local legacy mode. Deployed Better Auth ignores `OPS_TOKEN` entirely.

### Two-tunnel topology (demo to friends)

```
friend's phone ──Expo Go──► expo tunnel (@expo/ngrok) ──► Metro on your Mac
      │
      └── API/WS ──► https://….trycloudflare.com (cloudflared) ──► edge :8787 ──► archive :8788 ─┐
                                            │  └─ /auth/* proxy ──► identity :8789 ──────────────┤
                                            │  └─ payment-dispatch queue ──► payments :8790 ─────┤
                                            ▼                                                    ▼
                                      Durable Objects (live state)                    Postgres :54322
```

The backend tunnel carries app↔edge traffic; the Expo tunnel carries the JS bundle and Metro. Both are needed. Phones on the same Wi-Fi need neither — set `EXPO_PUBLIC_EDGE_URL` to the Mac's LAN IP instead (see `apps/mobile/.env.example`).

## The five workers

| Worker | Port | What it does | Env / secrets |
| --- | --- | --- | --- |
| `apps/edge` (`infra/wrangler.edge.toml`) | 8787 | Public API, Durable Objects (live state), operator JSON API and Better Auth; no embedded HTML. Proxies `/auth/*`, allowlisted client `/payments/*` routes, `/ops/api/admin/payments|holds|refunds`, and `/ops/api/device-resets*` (the ops device-reset queue → identity's internal seam) | Vars: `OPS_ARCHIVE_URL`, `IDENTITY_URL`, `PAYMENTS_URL`, `NOTIFICATIONS_URL`, `DATABASE_URL` + `ALLOW_HEADER_AUTH=true` (local demo), `OSRM_BASE_URL`, `PAYMENTS_REQUIRED` (unset = unpaid dev checkout), `EDGE_ENV=staging|production` (deployed), `OPS_BASE_URL`, `OPS_DASHBOARD_URL`, `RESEND_FROM_EMAIL`. Secrets: `OPS_AUTH_SECRET` (deployed), `RESEND_API_KEY` (admin magic links; shared with notifications), `OPS_TOKEN` (local legacy/`--tunnel` only), `IDENTITY_SESSION_SECRET` (must match the identity worker), `IDENTITY_INTERNAL_TOKEN` (must match the identity worker when set — the edge injects it as `x-identity-internal` on the guarded `/auth/*` routes; unset = nothing injected), `PAYMENTS_INTERNAL_TOKEN` (must match payments; required in staging/production) |
| `apps/archive` (`infra/wrangler.archive.toml`) | 8788 | Queue consumer: retirement snapshots → Postgres/R2; after commit, emits canonical settlement dispatch/refund requests before archive acknowledgement; reputation/admin read API; hourly finite retained-media R2 cleanup | Var: `DATABASE_URL` (dev) / Hyperdrive (prod). Queue: `PAYMENT_QUEUE` producer; archive retries + DLQ; cron `17 * * * *`; retained-media list/hold/release via `/admin/retained-media` (ADR-0031) |
| `apps/identity` (`infra/wrangler.identity.toml`) | 8789 | Hybrid face enroll, local verify/recovery, device keys, HMAC sessions, device reset, and private enrollment-capture lifecycle | Var: `DATABASE_URL` (dev) / Hyperdrive (prod). Secrets: `IDENTITY_ENCRYPTION_KEY`, `IDENTITY_SESSION_SECRET`, `IDENTITY_INTERNAL_TOKEN`, `BIOMETRICS_SERVICE_TOKEN`; vars `FACE_VERIFIER=hybrid`, `BIOMETRICS_SERVICE_URL`, `FACE_MATCH_THRESHOLD`, `FIDO_UPSERT_ENABLED`, `FIDO_STUB_ENABLED`. Smile ID secrets: `SMILEID_PARTNER_ID`, `SMILEID_API_KEY`; vars `SMILEID_ENV`, `SMILEID_CALLBACK_URL`, `SMILEID_PRIVACY_NOTICE_URL`. `IDENTITY_CAPTURES` is a private R2 binding; the scheduled five-minute sweep deletes abandoned expired pending captures (ADR-0028) |
| `apps/payments` (`infra/wrangler.payments.toml`) | 8790 | `payment-dispatch` + `payment.refund-requested` queue consumer: authorizes every request against the durable settlement, then persists each leg and executes it via the dispatcher abstraction (stub in dev; Flutterwave test-mode supported); buyer collection — `POST /payments/charges/confirm` (server-side verify → `payment_holds`), refund rail (card via provider, non-card → `refund-manual`), seller/runner payout accounts (`GET /payments/banks`, resolve-then-save) behind resolved-participant authorization; serves `GET /dispatches` + settlement-checked replay and canonical settlement re-drive, grouped `GET /recovery` for the Ops Recovery attention queue, `POST /webhooks/transfers|charges`, `POST /dispatches/sync` | Var: `DATABASE_URL` (dev) / Hyperdrive (prod), `PAYMENT_DISPATCHER=stub`. Secret: `PAYMENTS_INTERNAL_TOKEN` (same on edge and payments; required for every non-webhook route). Explicit local demo: `ALLOW_HEADER_AUTH=true` on both workers. Vendor secrets via `infra/.dev.vars` (below) |
| `apps/notifications` (`infra/wrangler.notifications.toml`) | 8791 | `notification-events` consumer plus durable notification read/mark-read API and realtime/email delivery | Var: `DATABASE_URL` (dev) / Hyperdrive (prod), `EDGE_URL`, `IDENTITY_URL`. Secrets: `NOTIFICATION_INTERNAL_TOKEN`, `RESEND_API_KEY`; verified sender var `RESEND_FROM_EMAIL` |

## Deployed topology and identity

`wrangler.edge.toml` and `wrangler.notifications.toml` contain explicit `staging` examples. Replace every `example.com` hostname with the staged worker's real HTTPS route before `wrangler deploy --env staging`. `EDGE_ENV=staging|production` makes the edge require all four service URLs and reject loopback/HTTP values before any route, including `/healthz`; `NOTIFICATIONS_ENV` applies the same check to notification fetches and queue delivery. The root `[vars]` remain local-development defaults and are never valid deployed topology.

Local proxy seams consume HTTPS URLs. Deployed ops reads and actions use the `ARCHIVE_SERVICE`, `PAYMENTS_SERVICE`, and `IDENTITY_SERVICE` bindings declared on the edge; the ops dashboard also reaches the edge through its `EDGE` binding. Other proxy seams still consume their configured URLs. A Cloudflare Service binding must be declared in the same environment **and** the owning proxy seam must call that binding; adding `[[env.staging.services]]` alone does not replace `IDENTITY_URL`, `PAYMENTS_URL`, `OPS_ARCHIVE_URL`, `NOTIFICATIONS_URL`, or `EDGE_URL`.

`wrangler.identity.toml` has an explicit `production` example with `IDENTITY_ENV=production`, `FACE_VERIFIER=hybrid`, and a non-local biometric service URL. Before deploying it, configure Hyperdrive, the private `IDENTITY_CAPTURES` binding, `BIOMETRICS_SERVICE_TOKEN`, all three identity secrets, and the Smile ID production credentials. Runtime validation rejects missing hybrid requirements, example privacy notices, and loopback biometrics even on health checks. Deployed staging keeps the same fail-closed requirements with Smile ID sandbox and the exact edge callback relationship. Locally, empty/stub test environments remain valid, while selecting hybrid enables the real-service validation above.

Initial ops market seeding mirrors `seed-core.mjs` with real geofences:

```bash
npx pnpm@9.15.4 --filter @market-runs/edge ops:seed-markets
npx pnpm@9.15.4 --filter @market-runs/edge ops:seed-markets -- Yaba --latitude 6.5 --longitude 3.38 --radius-meters 900
```

Balogun and Computer Village use the dev seed's centers and 750 m radius. Any custom market requires all three geofence flags; there is no silent Balogun fallback. Re-running a built-in seed repairs registry geography without replacing an existing market's runtime config.

## Flutterwave test-mode payouts (payments worker)

The committed zero-secret stub selector is an isolated test fixture (no money moves, deterministic `stub:` refs). A normal real-local run opts into Flutterwave explicitly and fails closed on invalid vendor configuration. To exercise real test-mode transfers with your Flutterwave development key:

1. `cp infra/.dev.vars.example infra/.dev.vars` — wrangler reads `.dev.vars` **next to the `--config` file** (verified: `npx wrangler dev --config infra/wrangler.payments.toml` from the repo root loads `infra/.dev.vars`, not a root-level file). `.dev.vars` is gitignored at any depth; never commit it.
2. In `infra/.dev.vars`, set `PAYMENT_DISPATCHER=flutterwave` and paste your **test** secret key as `FLUTTERWAVE_SECRET_KEY` (`FLWSECK_TEST-…`, dashboard → Settings → API keys). Test keys work against the production host; there is no separate sandbox URL.
3. (Webhooks, optional in dev) invent a random string — `openssl rand -hex 32` — set it as `FLUTTERWAVE_WEBHOOK_SECRET_HASH` and paste the same value into dashboard → Settings → Webhooks → Secret hash. Point the dashboard webhook at a tunnel to `http://localhost:8790/webhooks/transfers` (e.g. `cloudflared tunnel --url http://localhost:8790`). Unset hash ⇒ the route refuses with 503; wrong hash ⇒ 401.
4. Restart the payments worker (`infra/dev-servers.sh --stop` then `dev:all`, or the manual step 5 below).

Without `DEV_PAYOUT_RECIPIENTS`, the demo seed's seller stores (`Amina's Fresh Store`, `Mama Ngozi Provisions`, `Emeka Phones & Accessories`), `runner:internal`, and `platform` resolve to Flutterwave's documented **test** bank accounts (Access Bank `044`, `0690000031–33` — no real money). Seller legs carry the store display name as their party id at this stage (ADR-0014/0018); the test fallback is enabled only when `FLUTTERWAVE_SECRET_KEY` is a `FLWSECK_TEST-` key, so a live key can never pay a mock account. A seller with a saved payout account resolves DB-first (ADR-0025) by participant id; until the store→participant mapping lands, a display-name seller leg may still need an explicit `DEV_PAYOUT_RECIPIENTS` entry. Any other unmapped party fails `recipient-unresolved`. In-flight transfers converge to `completed`/`failed` via the webhook, via `POST /dispatches/sync` (bulk polls rows stale > 15 min), or via the Ops **Sync provider status** action for one `sent`/`queued` row (`POST /dispatches/:id/sync`; no replay and no attempt increment) when no webhook is reachable.

Dispatch failures are classified: transient failures (`provider-unreachable`, 429/5xx) are retryable and back off through the queue; deterministic failures (`recipient-unresolved`, amount outside the provider band, 4xx validation, provider-terminal `FAILED`) set `failure_retryable=false`, are acked instead of retried, and keep the run's hold held for an ops replay after the cause is fixed. `reconcile` treats a terminal failure as a FAIL immediately.

**Provider-reference alias (ADR-0024 amendment):** Flutterwave caps a transfer `reference` at 64 characters, and the canonical per-leg idempotency key is longer (66+; 75 with the test-mode suffix). The worker now sends a deterministic short alias — `mr_` + the first 48 hex characters of a domain-separated SHA-256 (51 characters; 60 with `_PMCKDU_1`) — and persists it in `payment_dispatches.provider_reference` (unique, nullable). The full idempotency key remains canonical for the queue, ops replay, and the ledger. Webhooks, duplicate-collapse lookups, and `infra/reconcile.mjs` match on the alias; rows created before the migration fall back to `idempotency_key`. This is a provider-boundary label only: amounts, recipients, settlement legs, holds, and ledger entries are unchanged.

**Mock-transfer accelerator (local dev only):** test-mode transfers otherwise sit PENDING ~10 min before the mock settles them. Setting `FLUTTERWAVE_TEST_MODE=1` in `infra/.dev.vars` appends the provider's magic `_PMCKDU_1` suffix to every outgoing provider alias, forcing SUCCESSFUL in ~1 min (provider-documented). Configuration hard-requires an `FLWSECK_TEST-` key; combining this accelerator with a live key fails before any transfer. The suffix is stripped from webhook/poll references before they are matched back to dispatch rows, so nothing upstream of the vendor quarantine ever sees it. **Never set this in a deployed environment** — it exists solely to shorten local feedback loops. A failure variant (`_PMCK_ST_FDU_1`) also exists for failure drills but is deliberately NOT wired in; append it to an alias manually when you want to drill the failure path. `infra/reconcile.mjs` strips the same suffix before its vendor comparison.

For any deploy: `wrangler secret put FLUTTERWAVE_SECRET_KEY --config infra/wrangler.payments.toml` (and `FLUTTERWAVE_WEBHOOK_SECRET_HASH`), plus `wrangler vars` for `PAYMENT_DISPATCHER=flutterwave`.

## Reconciliation tie-out (run after every test session)

`infra/reconcile.mjs` is the three-way tie-out for pilot sessions: Postgres settlement records ↔ double-entry ledger ↔ holds/refunds/dispatches, plus an optional vendor cross-check against Flutterwave. Doctrine under test: money is integer kobo, the settlement function is the only money decision (ADR-0007/0008), and **any unexplained kobo stops the test**.

```bash
node infra/reconcile.mjs                    # human report, exit 1 on any FAIL
node infra/reconcile.mjs --json             # machine-readable report (+ RECONCILE_EXIT line)
node infra/reconcile.mjs --market=Balogun   # scope to one market
# knobs: --pending-minutes=30  --held-hours=24  --max-attempts=6
# env:   DATABASE_URL (default local container), FLUTTERWAVE_SECRET_KEY (enables vendor check)
```

`reconcile` and `e2e-session` load `infra/.dev.vars` automatically when it exists, so the vendor tie-out uses the same key as the running workers; explicitly exported shell env values win. `e2e-session` also reads the payments worker's `GET /healthz` and reports the **active** dispatcher (`PAYMENTS_URL`, default `http://localhost:8790`), flagging a stale worker when it differs from `.dev.vars`.

What each check proves:

| Check | Proves |
| --- | --- |
| `ledger-balance` | Per settlement_record, debits == credits and the `buyer_capture` debit equals the captured total (outcome sellers + runner + net platform + refund). Dispute loss is already deducted from platform revenue, not external funding; legacy rows subtract only an actual `platform_loss` debit for backward-compatible reconciliation. The ledger agrees with the settlement function's kobo. |
| `hold-conservation` | Every collected kobo is accounted: `hold amount == (capture − buyerRefund) + effective refunds`. A `released` hold must have a settlement for its run; refund rows never exceed the hold. |
| `dispatch-completeness` | Every settlement payout leg (sellers → runner → platform, from the stored outcome) has exactly one `payment_dispatches` row keyed `settlement:<recordId>:leg:<n>` with the exact amount/account/party — no missing, extra, or drifted legs. A terminal (`failure_retryable=false`) failure is a FAIL immediately; a retryable failure WARNs until its attempt budget is exhausted. |
| `refund-rail` | Every refund ties to a real hold and to a settlement with `buyer_refund_kobo == amount_kobo`; a settlement that decided a refund has a refund row when a hold exists. `refund-manual`/`refund-review` rows are manual-action WARNs, not discrepancies. Admin resolutions are write-once in `payment_refund_resolutions` (migration 0018): accepted provider/manual refunds update hold truth; approved retries use the canonical queue. |
| `settlement-ledger` | No settlement without ledger entries; no orphan ledger entries. |
| `vendor` | With `FLUTTERWAVE_SECRET_KEY`: every executed (`completed`/`sent`/`queued`, `flw:` ref) dispatch has a provider transfer with `reference == provider_reference` (legacy rows: `idempotency_key`; the test-mode `_PMCKDU_1` suffix is stripped first) and matching amount (kobo→naira); provider transfers carrying our `mr_` or legacy `settlement:` reference shape with no local row are flagged. Stub-dispatcher rows are skipped by design. Without the key: `vendor check skipped (no key)` — not a failure. |

**Stop-the-test threshold: any FAIL. WARN budget is 0 unexplained.** WARNs (refund-manual/refund-review awaiting ops, dispatches stuck pending/sent/queued past `--pending-minutes`, holds `held` past `--held-hours`) must each be explained in the session notes or treated as failures. Exit code is `1` on any FAIL and the last line is always `RECONCILE_EXIT=0|1` for CI/scripts.

Expected posture caveat: a session run with `PAYMENTS_REQUIRED` unset (unpaid dev checkout) produces settlements with no holds and — if the payments worker wasn't consuming — no dispatch rows; `dispatch-completeness` FAILs on those until the queue drains. Run the tie-out with the full stack up so queued dispatches land first.

Dev defaults let the whole stack run with zero secrets; for any deploy set them with `wrangler secret put` per config (`--config infra/wrangler.<name>.toml`, plus `--env` for a named environment): `OPS_AUTH_SECRET`, `IDENTITY_SESSION_SECRET`, `IDENTITY_INTERNAL_TOKEN` and `PAYMENTS_INTERNAL_TOKEN` on the edge, `IDENTITY_ENCRYPTION_KEY` / `IDENTITY_SESSION_SECRET` / `IDENTITY_INTERNAL_TOKEN` on identity, and `PAYMENTS_INTERNAL_TOKEN` on payments. `OPS_TOKEN` is local legacy/`--tunnel` configuration, not a deployed Better Auth secret. `IDENTITY_SESSION_SECRET` must be the SAME value on edge and identity — the edge verifies session HMACs locally without a round trip. `IDENTITY_INTERNAL_TOKEN` must likewise be the SAME value on edge and identity when set — the edge's `/auth/*` proxy injects it as `x-identity-internal` on the guarded routes only (face enrollment, the device-reset queue read `GET /auth/device-reset`, device-reset decisions); unset on both leaves those routes open in dev. `PAYMENTS_INTERNAL_TOKEN` must be the SAME value on edge and payments; every non-webhook worker route and deployed edge topology fails closed without it. The local header-auth payout demo requires the explicit `ALLOW_HEADER_AUTH=true` override on both workers, never a deployed implicit fallback.

## Manual setup (fallback)

The whole MVP runs locally with no Cloudflare credentials:

```bash
# 1. Postgres (system of record — a throwaway local container stands in for Neon)
docker run -d --name market-runs-postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=market_runs -p 54322:5432 postgres:16-alpine
export DATABASE_URL="postgres://postgres:postgres@localhost:54322/market_runs"
(cd infra/drizzle && npx drizzle-kit migrate)

# 2. Core market rows (required before store registration; idempotent)
node infra/seed-core.mjs

# 3. Edge worker (DOs, WS gateways, ops console) on :8787
npx wrangler dev --config infra/wrangler.edge.toml --port 8787

# 4. Archive consumer (queue → Postgres/R2, reputation API) on :8788
npx wrangler dev --config infra/wrangler.archive.toml --port 8788 \
  --var DATABASE_URL:"$DATABASE_URL"

# 5. Identity worker (face/device-key/sessions) on :8789
npx wrangler dev --config infra/wrangler.identity.toml --port 8789 \
  --var DATABASE_URL:"$DATABASE_URL"

# 6. Payments worker (payment-dispatch queue consumer + /dispatches) on :8790
npx wrangler dev --config infra/wrangler.payments.toml --port 8790 \
  --var DATABASE_URL:"$DATABASE_URL"

# 7. Optional: seed demo stores (idempotent)
node infra/seed-demo.mjs
```

Or just `infra/dev-servers.sh` for steps 3–6 together (`infra/dev-servers.sh --stop` tears them down). It forwards `OPS_TOKEN` to the edge when that variable is set in the environment.

Wrangler's dev registry connects the edge's `ARCHIVE_QUEUE` producer to the archive consumer, then the archive's `PAYMENT_QUEUE` producer to the payments consumer. A settled run therefore commits in Postgres before its canonical dispatch/refund requests are emitted, and its payout legs land in `payment_dispatches` without any deploy. The ops console is at `http://localhost:8787/ops`; its reputation panel proxies to `OPS_ARCHIVE_URL` and its Payments tab to `PAYMENTS_URL` (`[vars]` entries, dev-only), while `/auth/*` proxies to `IDENTITY_URL`.

Tests:

```bash
pnpm test                        # domain + proto
(cd apps/edge && npx vitest run) # DO unit tests + public-HTTP e2e
(cd apps/archive && npx vitest run)
(cd apps/payments && npx vitest run)
```

`pnpm test:stack` creates a fresh temporary Postgres database, starts all five workers, waits for every health endpoint, runs the rehearsal, then stops the stack and drops only that temporary database. Set `KEEP_REHEARSAL_DB=1` to preserve a failed run's database for diagnosis. `pnpm test:e2e` (`infra/e2e-session.mjs`) rehearses the runbook's money scenarios end-to-end against the **already-running** dev stack (`npx pnpm@9.15.4 dev:all` — the script fails fast with that hint when the edge or Postgres is unreachable): S3 (intent → discovery → offer → accept → checkout → photo-gated handoffs, asserting the photoless scan's 409 `photo-required` → buyer dispute → ops settle `disputed`) and S4 (cart → checkout → pickup → ops settle `aborted`), asserting the settlement kobo against the domain split and ADR-0008 (`buyerRefund < capture`) on the wire and in Postgres (ledger balance, per-leg dispatches, the disputes row). It ends by running `infra/reconcile.mjs --json` as the tie-out — a reconcile FAIL fails the script. Re-runs never collide (fresh `buyer:e2e-*` ids per invocation); the last line is always `E2E_SESSION_EXIT=0|1|2`.

The archive and payments integration suites (`test/persist.integration.test.ts`,
`test/consume.integration.test.ts`) are first-class and hermetic: they run by
default against a **dedicated `market_runs_test` database** in the same dev
container (`postgres://postgres:postgres@localhost:54322/market_runs_test`),
created and migrated on first use, so a test run can never truncate the
`market_runs` dev/session evidence that `infra/reconcile.mjs` audits. Both
suites truncate their own tables on entry and exit; they FAIL with an actionable
message when Postgres is unreachable — they never silently skip. Point them
elsewhere with `ARCHIVE_TEST_DATABASE_URL` / `PAYMENTS_TEST_DATABASE_URL`.
