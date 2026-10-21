# Infrastructure

First real-human test session? Follow `docs/runbooks/first-live-test.md` — it builds on everything below.

Provision the Cloudflare resources referenced by the Wrangler configurations before deployment. Store credentials with `wrangler secret put`; never commit `.env`, `.dev.vars`, the Neon connection string, payment credentials, or identity verification credentials. Hyperdrive is configured out of band and must not contain a committed connection string.

## One-command demo stack (recommended)

```bash
npx pnpm@9.15.4 dev:all          # local: postgres + migrations + edge + archive + demo seed
npx pnpm@9.15.4 dev:all -- --tunnel   # + Cloudflare quick tunnel for friends' phones
npx pnpm@9.15.4 dev:all -- --no-seed  # skip the demo seed
```

`infra/dev-all.sh` (what `dev:all` runs) does, in order:

1. **Postgres** — starts the `market-runs-postgres` docker container (`postgres:16-alpine` on `:54322`) if needed, reuses it if already running, and waits for `pg_isready`.
2. **Migrations** — `drizzle-kit migrate` in `infra/drizzle` with `DATABASE_URL` (default `postgres://postgres:postgres@localhost:54322/market_runs`). Logs to `.dev-logs/migrate.log`.
3. **Edge + archive + identity + payments** — delegates to `infra/dev-servers.sh` (edge on `:8787`, archive on `:8788`, identity on `:8789`, payments on `:8790`, health checks, logs in `.dev-logs/`).
4. **Demo seed** (default on) — `infra/seed-demo.mjs` registers two Balogun stores (Amina's Fresh Store, Mama Ngozi Provisions) and one Computer Village store (Emeka Phones & Accessories) over the real `POST /command` wire, so a fresh backend has a market vocabulary buyers can post intents against. It uses deterministic store ids — re-running is a no-op.
5. **`--tunnel`** — runs `cloudflared tunnel --url http://localhost:8787`, captures the `*.trycloudflare.com` URL, and prints a summary box: the tunnel URL, the exact `EXPO_PUBLIC_EDGE_URL=…` line for `apps/mobile/.env`, the guarded `/ops?token=…` console link, and the friend-side step (`npx expo start --tunnel`, which needs `@expo/ngrok`). Without `cloudflared` installed it prints `brew install cloudflared` and continues LAN-only.

Ctrl-C stops everything the script started — the tunnel, both dev servers, and the Postgres container **only if the script started it** (a container you left running stays running; container data persists either way).

### OPS_TOKEN and the tunnel

`requireOps()` admits everyone as local-ops when `OPS_TOKEN` is unset — fine on localhost, dangerous on a public tunnel URL (it would expose market config writes and ops settlements). So with `--tunnel`:

- if `OPS_TOKEN` is unset, a random one is generated, passed to the edge as a wrangler var, and printed in the summary box;
- a set-but-short token (< 16 chars) triggers a loud warning;
- without `--tunnel`, `OPS_TOKEN` stays optional and the console stays open (dev behavior unchanged).

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

## The four workers

| Worker | Port | What it does | Env / secrets |
| --- | --- | --- | --- |
| `apps/edge` (`infra/wrangler.edge.toml`) | 8787 | Public API, Durable Objects (live state), ops console; proxies `/auth/*`, `/payments/*`, `/ops/api/admin/payments|holds|refunds`, and `/ops/api/device-resets*` (the ops device-reset queue → identity's internal seam) | Vars: `OPS_ARCHIVE_URL`, `IDENTITY_URL`, `PAYMENTS_URL`, `OSRM_BASE_URL`, `PAYMENTS_REQUIRED` (unset = unpaid dev checkout). Secrets: `OPS_TOKEN` (any deploy / `--tunnel`), `IDENTITY_SESSION_SECRET` (must match the identity worker), `IDENTITY_INTERNAL_TOKEN` (must match the identity worker when set — the edge injects it as `x-identity-internal` on the guarded `/auth/*` routes; unset = nothing injected) |
| `apps/archive` (`infra/wrangler.archive.toml`) | 8788 | Queue consumer: retirement snapshots → Postgres/R2 + reputation/admin read API | Var: `DATABASE_URL` (dev) / Hyperdrive (prod) |
| `apps/identity` (`infra/wrangler.identity.toml`) | 8789 | Face enroll/verify, device-key registration/authentication, HMAC sessions, device-reset — owns all credential state in Postgres | Var: `DATABASE_URL` (dev) / Hyperdrive (prod). Secrets: `IDENTITY_ENCRYPTION_KEY`, `IDENTITY_SESSION_SECRET`, `IDENTITY_INTERNAL_TOKEN` (must be the SAME value on edge and identity when set — the edge's `/auth/*` proxy injects it on the guarded routes; unset = internal routes open in dev). Vars: `FACE_VERIFIER` (stub \| smileid — smileid without keys throws at startup), `FACE_MATCH_THRESHOLD`, `FIDO_UPSERT_ENABLED`, `FIDO_STUB_ENABLED`. Smile ID secrets when enabled: `SMILEID_PARTNER_ID`, `SMILEID_API_KEY`, plus vars `SMILEID_ENV` (default sandbox), `SMILEID_CALLBACK_URL`, `SMILEID_PRIVACY_NOTICE_URL` (ADR-0022, amended) |
| `apps/payments` (`infra/wrangler.payments.toml`) | 8790 | `payment-dispatch` + `payment.refund-requested` queue consumer: persists each settlement leg and executes it via the dispatcher abstraction (stub in dev; Flutterwave test-mode supported); buyer collection — `POST /payments/charges/confirm` (server-side verify → `payment_holds`), refund rail (card via provider, non-card → `refund-manual`), seller payout accounts (`GET /payments/banks`, resolve-then-save); serves `GET /dispatches` + replay, `POST /webhooks/transfers|charges`, `POST /dispatches/sync` | Var: `DATABASE_URL` (dev) / Hyperdrive (prod), `PAYMENT_DISPATCHER=stub`. Vendor secrets via `infra/.dev.vars` (below) |

## Flutterwave test-mode payouts (payments worker)

The dev default is the stub dispatcher (no money moves, deterministic `stub:` refs). To exercise real test-mode transfers with your Flutterwave development key:

1. `cp infra/.dev.vars.example infra/.dev.vars` — wrangler reads `.dev.vars` **next to the `--config` file** (verified: `npx wrangler dev --config infra/wrangler.payments.toml` from the repo root loads `infra/.dev.vars`, not a root-level file). `.dev.vars` is gitignored at any depth; never commit it.
2. In `infra/.dev.vars`, set `PAYMENT_DISPATCHER=flutterwave` and paste your **test** secret key as `FLUTTERWAVE_SECRET_KEY` (`FLWSECK_TEST-…`, dashboard → Settings → API keys). Test keys work against the production host; there is no separate sandbox URL.
3. (Webhooks, optional in dev) invent a random string — `openssl rand -hex 32` — set it as `FLUTTERWAVE_WEBHOOK_SECRET_HASH` and paste the same value into dashboard → Settings → Webhooks → Secret hash. Point the dashboard webhook at a tunnel to `http://localhost:8790/webhooks/transfers` (e.g. `cloudflared tunnel --url http://localhost:8790`). Unset hash ⇒ the route refuses with 503; wrong hash ⇒ 401.
4. Restart the payments worker (`infra/dev-servers.sh --stop` then `dev:all`, or the manual step 5 below).

Without `DEV_PAYOUT_RECIPIENTS`, the demo parties (`seller:amina`, `runner:internal`, `platform`) resolve to Flutterwave's documented **test** bank accounts (Access Bank `044`, `0690000031–33` — no real money). A seller with a saved payout account resolves DB-first (ADR-0025), ahead of both; any other unmapped party fails `recipient-unresolved` and is replayable from the Payments tab once mapped. In-flight transfers converge to `completed`/`failed` via the webhook, or via `POST /dispatches/sync` (polls rows stale > 15 min) when no webhook is reachable.

**Mock-transfer accelerator (local dev only):** test-mode transfers otherwise sit PENDING ~10 min before the mock settles them. Setting `FLUTTERWAVE_TEST_MODE=1` in `infra/.dev.vars` appends the provider's magic `_PMCKDU_1` suffix to every outgoing transfer `reference`, forcing SUCCESSFUL in ~1 min (provider-documented). The suffix is stripped from webhook/poll references before they are matched back to dispatch rows, so nothing upstream of the vendor quarantine ever sees it. **Never set this in a deployed environment** — it exists solely to shorten local feedback loops. A failure variant (`_PMCK_ST_FDU_1`) also exists for failure drills but is deliberately NOT wired in; append it to a reference manually when you want to drill the failure path. Note: while test mode is on, `infra/reconcile.mjs`'s vendor cross-check compares provider references to bare idempotency keys — suffixed references read as a mismatch there.

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

What each check proves:

| Check | Proves |
| --- | --- |
| `ledger-balance` | Per settlement_record, debits == credits and the `buyer_capture` debit equals the captured total (outcome sellers + runner + platform + refund − loss). The ledger agrees with the settlement function's kobo. |
| `hold-conservation` | Every collected kobo is accounted: `hold amount == (capture − buyerRefund) + effective refunds`. A `released` hold must have a settlement for its run; refund rows never exceed the hold. |
| `dispatch-completeness` | Every settlement payout leg (sellers → runner → platform, from the stored outcome) has exactly one `payment_dispatches` row keyed `settlement:<recordId>:leg:<n>` with the exact amount/account/party — no missing, extra, or drifted legs. |
| `refund-rail` | Every refund ties to a real hold and to a settlement with `buyer_refund_kobo == amount_kobo`; a settlement that decided a refund has a refund row when a hold exists. `refund-manual` rows are REPORTED (ops must act), not discrepancies. |
| `settlement-ledger` | No settlement without ledger entries; no orphan ledger entries. |
| `vendor` | With `FLUTTERWAVE_SECRET_KEY`: every executed (`completed`/`sent`/`queued`, `flw:` ref) dispatch has a provider transfer with `reference == idempotencyKey` and matching amount (kobo→naira); provider transfers carrying our `settlement:` reference shape with no local row are flagged. Stub-dispatcher rows are skipped by design. Without the key: `vendor check skipped (no key)` — not a failure. |

**Stop-the-test threshold: any FAIL. WARN budget is 0 unexplained.** WARNs (refund-manual awaiting ops, dispatches stuck pending/sent/queued past `--pending-minutes`, holds `held` past `--held-hours`) must each be explained in the session notes or treated as failures. Exit code is `1` on any FAIL and the last line is always `RECONCILE_EXIT=0|1` for CI/scripts.

Expected posture caveat: a session run with `PAYMENTS_REQUIRED` unset (unpaid dev checkout) produces settlements with no holds and — if the payments worker wasn't consuming — no dispatch rows; `dispatch-completeness` FAILs on those until the queue drains. Run the tie-out with the full stack up so queued dispatches land first.

Dev defaults let the whole stack run with zero secrets; for any deploy set them with `wrangler secret put` per config (`--config infra/wrangler.<name>.toml`): `OPS_TOKEN`, `IDENTITY_SESSION_SECRET` and `IDENTITY_INTERNAL_TOKEN` on the edge, `IDENTITY_ENCRYPTION_KEY` / `IDENTITY_SESSION_SECRET` / `IDENTITY_INTERNAL_TOKEN` on identity. `IDENTITY_SESSION_SECRET` must be the SAME value on edge and identity — the edge verifies session HMACs locally without a round trip. `IDENTITY_INTERNAL_TOKEN` must likewise be the SAME value on edge and identity when set — the edge's `/auth/*` proxy injects it as `x-identity-internal` on the guarded routes only (face enrollment, the device-reset queue read `GET /auth/device-reset`, device-reset decisions); unset on both leaves those routes open in dev.

## Manual setup (fallback)

The whole MVP runs locally with no Cloudflare credentials:

```bash
# 1. Postgres (system of record — a throwaway local container stands in for Neon)
docker run -d --name market-runs-postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=market_runs -p 54322:5432 postgres:16-alpine
export DATABASE_URL="postgres://postgres:postgres@localhost:54322/market_runs"
(cd infra/drizzle && npx drizzle-kit migrate)

# 2. Edge worker (DOs, WS gateways, ops console) on :8787
npx wrangler dev --config infra/wrangler.edge.toml --port 8787

# 3. Archive consumer (queue → Postgres/R2, reputation API) on :8788
npx wrangler dev --config infra/wrangler.archive.toml --port 8788 \
  --var DATABASE_URL:"$DATABASE_URL"

# 4. Identity worker (face/device-key/sessions) on :8789
npx wrangler dev --config infra/wrangler.identity.toml --port 8789 \
  --var DATABASE_URL:"$DATABASE_URL"

# 5. Payments worker (payment-dispatch queue consumer + /dispatches) on :8790
npx wrangler dev --config infra/wrangler.payments.toml --port 8790 \
  --var DATABASE_URL:"$DATABASE_URL"

# 6. Optional: seed demo stores (idempotent)
node infra/seed-demo.mjs
```

Or just `infra/dev-servers.sh` for steps 2–5 together (`infra/dev-servers.sh --stop` tears them down). It forwards `OPS_TOKEN` to the edge when that variable is set in the environment.

Wrangler's dev registry connects the edge's `ARCHIVE_QUEUE` producer to the archive consumer (and `PAYMENT_QUEUE` to the payments consumer) automatically when the dev servers run, so a settled run lands in Postgres — and its payout legs in `payment_dispatches` — without any deploy. The ops console is at `http://localhost:8787/ops`; its reputation panel proxies to `OPS_ARCHIVE_URL` and its Payments tab to `PAYMENTS_URL` (`[vars]` entries, dev-only), while `/auth/*` proxies to `IDENTITY_URL`.

Tests:

```bash
pnpm test                        # domain + proto
(cd apps/edge && npx vitest run) # DO unit tests + public-HTTP e2e
(cd apps/archive && npx vitest run)
(cd apps/payments && npx vitest run)
```

`pnpm test:e2e` (`infra/e2e-session.mjs`) rehearses the runbook's money scenarios end-to-end against the **already-running** dev stack (`npx pnpm@9.15.4 dev:all` — the script fails fast with that hint when the edge or Postgres is unreachable): S3 (intent → discovery → offer → accept → checkout → photo-gated handoffs, asserting the photoless scan's 409 `photo-required` → buyer dispute → ops settle `disputed`) and S4 (cart → checkout → pickup → ops settle `aborted`), asserting the settlement kobo against the domain split and ADR-0008 (`buyerRefund < capture`) on the wire and in Postgres (ledger balance, per-leg dispatches, the disputes row). It ends by running `infra/reconcile.mjs --json` as the tie-out — a reconcile FAIL fails the script. Re-runs never collide (fresh `buyer:e2e-*` ids per invocation); the last line is always `E2E_SESSION_EXIT=0|1|2`.

The archive and payments integration suites (`test/persist.integration.test.ts`,
`test/consume.integration.test.ts`) are first-class and hermetic: they run by
default against a **dedicated `market_runs_test` database** in the same dev
container (`postgres://postgres:postgres@localhost:54322/market_runs_test`),
created and migrated on first use, so a test run can never truncate the
`market_runs` dev/session evidence that `infra/reconcile.mjs` audits. Both
suites truncate their own tables on entry and exit; they FAIL with an actionable
message when Postgres is unreachable — they never silently skip. Point them
elsewhere with `ARCHIVE_TEST_DATABASE_URL` / `PAYMENTS_TEST_DATABASE_URL`.
