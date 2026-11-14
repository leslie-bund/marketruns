# Runbook — staging provisioning, deployment, go/no-go, and rollback

This is the followable-cold procedure for a repeatable **staging** deployment. The default rehearsal posture is real Flutterwave **test-mode** payments plus hybrid identity: Smile ID **sandbox**, an externally deployed private biometrics service, and private identity-capture R2. The wizard applies migrations through `0018_audited_refund_resolutions`, provisions the archive/payment/notification queues and DLQs, archive and identity-capture R2, and one shared Hyperdrive configuration, then deploys in the archive-first order required by ADR-0029.

**OSRM remains out of scope:** staging edge leaves `OSRM_BASE_URL` unset so checkout uses static floor-rate estimates. `stub` payment/identity mode is available only for explicitly infrastructure-only validation. It is not approval for a real paid/hybrid rehearsal.

## 1. Required human inputs

Collect these before starting. The wizard opens the relevant service dashboards and explains where each value belongs.

| Input | Required form / destination |
| --- | --- |
| Cloudflare access | Wrangler login with permission to manage Workers, Queues, R2, Hyperdrive, secrets, and deployments in the staging account |
| Public Worker routes | Five **distinct**, non-local HTTPS Worker origins, with no URL paths: edge, archive, identity, payments, notifications, plus a separate reachable `OPS_DASHBOARD_URL`. Use `https://ops.marketruns.org` once its Cloudflare Custom Domain is active; until then use `https://market-runs-ops-staging.leslie-bund.workers.dev` so admin magic links remain reachable. Edge is also `OPS_BASE_URL`; the dashboard origin is embedded in admin magic links. |
| Launch market | Exact market name. `Balogun` and `Computer Village` have built-in geography; any other name also needs center latitude, center longitude, and a positive integer radius in meters. |
| Neon | **Staging** pooled Postgres connection string. Used directly for migrations/CLI and by Hyperdrive at runtime. Never use the production database. |
| Ops and document auth | `OPS_AUTH_SECRET` (at least 32 characters) and `ID_DOCUMENT_HMAC_SECRET` |
| Shared service auth | Independent random values for `ARCHIVE_INTERNAL_TOKEN`, `NOTIFICATION_INTERNAL_TOKEN`, `PAYMENTS_INTERNAL_TOKEN`, `IDENTITY_SESSION_SECRET`, and `IDENTITY_INTERNAL_TOKEN` |
| Identity encryption | `IDENTITY_ENCRYPTION_KEY`, base64 encoding exactly 32 random bytes |
| Smile ID sandbox | `SMILEID_PARTNER_ID` and `SMILEID_API_KEY` from the sandbox environment; the wizard fixes `SMILEID_ENV=sandbox` and derives `SMILEID_CALLBACK_URL=$EDGE_PUBLIC_URL/callbacks/smileid` |
| Published privacy notice | Real, publicly reachable, non-local HTTPS `SMILEID_PRIVACY_NOTICE_URL`; no `example.com`, placeholder, or unpublished draft. Complete legal/owner review before collection. |
| External private biometrics | Non-local HTTPS `BIOMETRICS_SERVICE_URL`; real ArcFace and MiniFASNet model artifacts; `BIOMETRICS_SERVICE_TOKEN` of at least 32 characters. The service is a prerequisite, not something this wizard deploys. |
| Flutterwave | `FLUTTERWAVE_SECRET_KEY` must be `FLWSECK_TEST-…` for paid staging; `FLUTTERWAVE_WEBHOOK_SECRET_HASH`; mobile also needs a `FLWPUBK_TEST-…` public key. Fund the NGN **test payout balance** for every settlement leg plus fees; test collections do not settle into that balance. |
| Resend | `RESEND_API_KEY` and a verified `RESEND_FROM_EMAIL` sender |
| Mobile/EAS | Staging `EXPO_PUBLIC_EDGE_URL`, `EXPO_PUBLIC_FLW_PUBLIC_KEY`, and `GOOGLE_MAPS_API_KEY`; use an Android-restricted staging Maps key |
| First ops admin | Email and a temporary password of at least 12 characters. A password change is required at first login. |

The wizard keeps rerunnable state in `infra/.staging/.dev.vars`. That basename is gitignored at any depth, and the wizard creates the file with mode `0600`. It contains secrets: do not commit, upload, print, or share it. Public staging values and resource IDs are written to the five `infra/wrangler.*.toml` files **only after confirmation**. Skipping that gate preserves all existing placeholders and stops before secret/deployment stages.

## 2. Provision with the wizard

From the repository root:

```bash
bash infra/staging-setup.sh
```

Do not pipe the wizard's input or run it unattended. Its 15 stages are:

1. Preflight and Wrangler authentication.
2. Launch market/geofence, five distinct public Worker routes, and the dedicated ops dashboard origin.
3. `stub` infrastructure-only or `flutterwave` paid-test posture. Paid mode selects `FACE_VERIFIER=hybrid`; stub selects payment and identity stubs.
4. Smile ID sandbox callback/privacy configuration, hybrid public values and secrets, biometrics health, and explicit model/token/HTTPS confirmation.
5. Neon and Hyperdrive.
6. Six queues/DLQs, archive R2, and—only for hybrid—the private identity-capture R2 bucket.
7. Confirmed public staging TOML updates.
8. Edge/identity auth secrets, including the three hybrid identity secrets when selected.
9. Archive/notifications/payments shared service auth.
10. Flutterwave and Resend secrets.
11. Migrations through `0018` and launch-market seed.
12. One-time first ops admin bootstrap.
13. Paid mobile/EAS and webhook configuration.
14. Archive-first Worker deployment; external biometrics must already be running.
15. Strict executable go/no-go and reconciliation.

Existing resources are reused by name/id. Secret entry is hidden. Secret values are piped to `wrangler secret put`; they are never written to tracked TOML. On a re-run, Enter keeps an existing state-file value. To rotate a value, paste a replacement rather than accepting the current one.

### Resource names

| Resource | Staging name |
| --- | --- |
| Archive queue / DLQ | `archive-snapshots-staging` / `archive-snapshots-dlq-staging` |
| Payment queue / DLQ | `payment-dispatch-staging` / `payment-dispatch-dlq-staging` |
| Notification queue / DLQ | `notification-events-staging` / `notification-events-dlq-staging` |
| Marketplace evidence R2 | `market-runs-archive-staging` |
| Identity captures R2 / binding | `market-runs-identity-captures-staging` / `IDENTITY_CAPTURES` on identity only |
| Hyperdrive / binding | `market-runs-staging` / `HYPERDRIVE` on all five Workers |

Never attach a public bucket domain or public read route to identity captures. The bucket stores pending and enrolled normalized selfies under opaque identity-owned keys.

## 3. Public URL and variable matrix

The generator validates these values before changing TOML and checks them again during go/no-go. All five Worker origins must be distinct, non-local HTTPS origins without paths or credentials. No staging `example.com` or `set-with-wrangler` placeholder may remain.

| Value | Destination / required relationship |
| --- | --- |
| `EDGE_PUBLIC_URL` | edge `OPS_BASE_URL`; notifications `EDGE_URL`; hybrid identity `EDGE_URL`; base of the Smile ID callback |
| `ARCHIVE_PUBLIC_URL` | edge `OPS_ARCHIVE_URL` |
| `IDENTITY_PUBLIC_URL` | edge `IDENTITY_URL` |
| `PAYMENTS_PUBLIC_URL` | edge `PAYMENTS_URL` |
| `NOTIFICATIONS_PUBLIC_URL` | edge `NOTIFICATIONS_URL` |
| `SMILEID_CALLBACK_URL` | identity; exactly `$EDGE_PUBLIC_URL/callbacks/smileid` |
| `SMILEID_PRIVACY_NOTICE_URL` | identity; real public HTTPS notice, paths allowed, no local/example host |
| `BIOMETRICS_SERVICE_URL` | identity; non-local HTTPS **origin only**, no path, credentials, query, or fragment |
| `SMILEID_ENV` | identity; exactly `sandbox` in hybrid staging |
| `IDENTITY_ENV` | identity; exactly `staging` |
| `FACE_VERIFIER` | identity; `hybrid` for a real rehearsal, `stub` only for infrastructure-only mode |
| `PAYMENTS_REQUIRED` | edge; `true` with Flutterwave paid staging, `false` only with infrastructure stub |
| `PAYMENT_DISPATCHER` | payments; `flutterwave` or infrastructure-only `stub` |

Identity uses its `EDGE_URL` for KYC reconciliation back into edge. Smile ID calls the **edge** callback; edge proxies the raw body and signature headers to identity, which remains responsible for callback authentication.

## 4. Secret and token matrix

The wizard applies this matrix with `--env staging`. Shared values must match exactly on each listed Worker; no secret value appears in the runbook or tracked config.

| Worker/service | Secrets or tokens |
| --- | --- |
| edge | `OPS_AUTH_SECRET`, `ID_DOCUMENT_HMAC_SECRET`, `ARCHIVE_INTERNAL_TOKEN`, `NOTIFICATION_INTERNAL_TOKEN`, `PAYMENTS_INTERNAL_TOKEN`, `IDENTITY_SESSION_SECRET`, `IDENTITY_INTERNAL_TOKEN`, `RESEND_API_KEY` |
| archive | `ARCHIVE_INTERNAL_TOKEN` |
| identity | `IDENTITY_ENCRYPTION_KEY`, `IDENTITY_SESSION_SECRET`, `IDENTITY_INTERNAL_TOKEN`; hybrid adds `SMILEID_PARTNER_ID`, `SMILEID_API_KEY`, `BIOMETRICS_SERVICE_TOKEN` |
| payments | `PAYMENTS_INTERNAL_TOKEN`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_SECRET_HASH` |
| notifications | `NOTIFICATION_INTERNAL_TOKEN`, `RESEND_API_KEY` |
| external biometrics service | `BIOMETRICS_INTERNAL_TOKEN` must be **exactly the same value** as identity `BIOMETRICS_SERVICE_TOKEN` |

`RESEND_FROM_EMAIL` is public Worker configuration on edge and notifications, not a secret. Edge uses it only for existing-admin magic links; notifications uses it for participant delivery. `OPS_TOKEN` and `ALLOW_HEADER_AUTH=true` are local-development mechanisms and must not be enabled in staging. The biometrics token never belongs on edge, payments, notifications, or the mobile app.

For a manual repair, use the matching config and let Wrangler prompt without echoing the value:

```bash
npx wrangler secret put OPS_AUTH_SECRET --config infra/wrangler.edge.toml --env staging
npx wrangler secret list --config infra/wrangler.identity.toml --env staging --format json
```

`secret list` verifies names only. It cannot prove that shared values match or that a vendor credential is correct. Do not paste secret values into shell history, issue descriptions, logs, or command output.

## 5. Hybrid identity prerequisites

### 5.1 External biometrics and models

Deploy `apps/biometrics` separately before identity. The wizard deliberately does **not** build, deploy, expose, or provision this service or its models.

Required service posture:

- `FACE_MODEL_PATH` points to a readable ArcFace `w600k_r50.onnx` artifact (112×112 RGB input, 512-value embedding).
- `LIVENESS_MODEL_PATH` points to a readable MiniFASNet ONNX artifact (80×80 BGR, three-class output with class 1 = live). It is required for `/v1/face/analyze` and routine local login/recovery, not enrollment-only `/embed`.
- Model artifacts are appropriately licensed and mounted as read-only runtime assets; they are not included in this repository.
- `LIVENESS_THRESHOLD` is deliberately selected and benchmarked before launch; the engineering default is not an accuracy claim.
- `BIOMETRICS_INTERNAL_TOKEN` exactly matches identity `BIOMETRICS_SERVICE_TOKEN` and has at least 32 characters.
- Identity can reach the non-local HTTPS origin. Do not add a mobile route, admin route, identification endpoint, or persistent capture store to this service.

`GET /healthz` is intentionally unauthenticated and reports the service and model version. `POST /v1/face/embed` and `/v1/face/analyze` require bearer auth. The wizard and strict checker require healthy service/model-version output; the checker also confirms an invalid bearer token receives `401`.

### 5.2 Smile ID sandbox, privacy, and captures

1. In the Smile ID portal, select **sandbox** and configure the callback/webhook URL as `$EDGE_PUBLIC_URL/callbacks/smileid`. Portal labels can vary; do not register a local or identity-only callback.
2. Publish the legally/owner-approved privacy notice at `SMILEID_PRIVACY_NOTICE_URL`. Complete every owner/legal placeholder in the source notice before publication, approve biometric consent and retention language, and record the accepted notice version in the enrollment flow.
3. Keep `SMILEID_ENV=sandbox`; never point a staging rehearsal at Smile ID production.
4. Provision/reuse `market-runs-identity-captures-staging` and bind it as `IDENTITY_CAPTURES` only on identity. Keep it private with no public domain, signed-URL read path, Ops read path, or mobile read path.
5. Confirm the external biometrics service has real ArcFace/MiniFASNet models, a matching token, and reachable HTTPS. The wizard requires this explicit confirmation in addition to its HTTP health check.

Hybrid staging requires `SMILEID_PARTNER_ID`, `SMILEID_API_KEY`, `BIOMETRICS_SERVICE_TOKEN`, all public hybrid variables, Hyperdrive, and the capture binding. Missing configuration is a no-go, not permission to fall back silently to stub.

## 6. Database migrations and launch market

The wizard runs the equivalent of:

```bash
(
  cd infra/drizzle
  DATABASE_URL="$DATABASE_URL" npx drizzle-kit migrate
)
```

This connects directly to Neon; Hyperdrive is not the migration path. Migration is idempotent. The checker then computes the SHA-256 of `0018_audited_refund_resolutions.sql` and requires the matching `created_at` and hash in `drizzle.__drizzle_migrations`, plus the `payment_refund_resolutions` table. It does not merely count migrations. Hybrid capture retention also depends on the earlier identity migrations in this sequence.

Market seed uses the real ops CLI:

```bash
DATABASE_URL="$DATABASE_URL" \
OPS_AUTH_SECRET="$OPS_AUTH_SECRET" \
OPS_BASE_URL="$EDGE_PUBLIC_URL" \
npx pnpm@9.15.4 --filter @market-runs/edge ops:seed-markets -- \
  "$LAUNCH_MARKET" --latitude "$LAT" --longitude "$LNG" --radius-meters "$RADIUS"
```

For `Balogun` or `Computer Village`, omit all three geofence flags to use the built-in geography. For any custom market, supply all three. Re-running repairs registry geography without replacing runtime MarketDO configuration.

After the first administrator exists, operators can instead onboard additional markets in the dedicated ops app: choose **Onboard market**, click the map or drag the marker to set the center, and set the radius with the numeric field or slider. Latitude/longitude inputs are the keyboard and tile-outage fallback. This calls the same audited `POST /ops/api/markets` route, applies the 08:00–18:00 registry hours plus existing launch rate/settlement defaults, and starts exchange and muster points empty. The Leaflet map loads public OpenStreetMap tiles and must retain the visible OpenStreetMap attribution; tile access requires external network connectivity. Use a simulated/intercepted response for UI tests so rehearsal testing does not create unintended registry entries.

## 7. First ops admin

Run only when no operator exists; bootstrap closes permanently after the first user is created:

```bash
DATABASE_URL="$DATABASE_URL" \
OPS_AUTH_SECRET="$OPS_AUTH_SECRET" \
OPS_BASE_URL="$EDGE_PUBLIC_URL" \
OPS_REQUIRE_PASSWORD_CHANGE=true \
npx pnpm@9.15.4 --filter @market-runs/edge ops:bootstrap-admin -- \
  --email "$OPS_ADMIN_EMAIL" --password "$OPS_ADMIN_PASSWORD"
```

Use a temporary password of at least 12 characters and enter it through the wizard's hidden prompt rather than placing it in shell history. After deployment, open the dedicated ops app at `https://ops.marketruns.org` (or `https://market-runs-ops-staging.leslie-bund.workers.dev`), sign in, and complete the required password change. The embedded edge fallback no longer exists. Existing admins can instead choose **Email me a sign-in link**: edge sends a ten-minute single-use link through Resend only for an existing admin address, with no self-registration or non-admin delivery. The current staging administrator is `founder@marketruns.org`; its password and Resend key are held only in staging secrets. The go/no-go also requires at least one database user with role `admin` and verifies that anonymous `/ops/api/overview` access is rejected.

## 8. Paid staging and mobile/EAS configuration

For `PAYMENT_DISPATCHER=flutterwave`, the public TOML update sets:

- edge `PAYMENTS_REQUIRED="true"`;
- payments `PAYMENT_DISPATCHER="flutterwave"`;
- identity `FACE_VERIFIER="hybrid"`, `SMILEID_ENV="sandbox"`, and all required hybrid URLs;
- edge `OPS_BASE_URL` and identity `EDGE_URL` to the edge origin.

The operator must also:

1. In Flutterwave **test mode**, set Settings → Webhooks → transfer webhook URL to `$EDGE_PUBLIC_URL/webhooks/transfers`, using exactly `FLUTTERWAVE_WEBHOOK_SECRET_HASH` as the secret hash.
2. In Flutterwave **test mode**, open Balance → Fund balance and fund the NGN payout balance for all expected transfer legs plus fees. Test collections are mocked and do not settle into the available payout balance. If a leg fails for insufficient funds, fund that balance and replay only the existing failed leg from Ops after fixing the cause; never create a replacement settlement or buyer charge.
3. Configure these as EAS project environment variables for the **Preview** environment, which is the environment selected by the `staging` build profile:

   | EAS name | Value |
   | --- | --- |
   | `EXPO_PUBLIC_EDGE_URL` | `$EDGE_PUBLIC_URL` |
   | `EXPO_PUBLIC_FLW_PUBLIC_KEY` | Captured `FLWPUBK_TEST-…` key |
   | `GOOGLE_MAPS_API_KEY` | Captured Android-restricted staging Maps key |

4. Rebuild the staging binary after changing EAS values; existing binaries do not acquire new build-time configuration.
5. For internal iOS distribution, connect an Apple Developer team with `cd apps/mobile && npx eas-cli device:create`, register each tester device, then run `npx eas-cli build --profile staging --platform ios`. Only devices in the ad-hoc provisioning profile can install the resulting IPA.
6. Use only Flutterwave test cards and test bank accounts. Never set `FLUTTERWAVE_TEST_MODE` in staging; that accelerator is local-development-only.

For the repeatable real-session paid/hybrid rehearsal, first copy the inherited, approved aligned sandbox image to `tmp/staging-paid-rehearsal/aligned-crop.png`. Then run each phase from the repository root, preserving `tmp/staging-paid-rehearsal/state.json` between invocations:

```bash
node infra/staging-paid-rehearsal.mjs --fresh --phase=setup
node infra/staging-paid-rehearsal.mjs --phase=trade
node infra/staging-paid-rehearsal.mjs --phase=handoffs
node infra/staging-paid-rehearsal.mjs --phase=settle
```

A fresh run enrolls buyer, seller, and runner with the official sandbox fixture. Set `STAGING_EXISTING_BUYER` only when deliberately reusing an already enrolled buyer. The harness uses real Bearer sessions and a real Flutterwave **TEST** charge, requires `RECONCILE_PROVIDER_SINCE`, and stores sessions only in the ignored mode-`0600` state file. It does not replay failed payment legs automatically.

`stub` mode sets `PAYMENTS_REQUIRED="false"`, uses the payment and identity stubs, removes hybrid-only public identity variables, and moves no money. `bash infra/staging-check.sh --allow-stub` returns only an **infrastructure-only** result, even when its checks pass; it never approves a paid/hybrid rehearsal.

## 9. Deployment order

Complete external biometrics deployment and its health/model/token confirmation first. After resources, bindings, migrations, secrets, provider callbacks, and privacy publication are ready, deploy Workers in this order:

```bash
npx wrangler deploy --config infra/wrangler.archive.toml --env staging
npx wrangler deploy --config infra/wrangler.identity.toml --env staging
npx wrangler deploy --config infra/wrangler.payments.toml --env staging
npx wrangler deploy --config infra/wrangler.notifications.toml --env staging
npx wrangler deploy --config infra/wrangler.edge.toml --env staging
```

The archive deploys its canonical payment producer **before** edge. During a mixed-version rollout, temporary dual emission is idempotent. Reversing this order can create a payment-emission gap (ADR-0029). Do not remove or rewrite queue messages as part of deployment. Identity deploys after its external biometrics dependency is available; edge deploys last so the public callback/proxy plane lands after its owning Workers.

Build and deploy the dedicated dashboard after edge:

```bash
npx pnpm@9.15.4 --filter @market-runs/ops build
npx wrangler deploy --config apps/ops/wrangler.toml --env staging
```

`apps/ops/wrangler.toml` declares `ops.marketruns.org` with `custom_domain = true` and retains the `workers.dev` preview. When `marketruns.org` is an active Cloudflare zone in the same account, deployment creates its DNS record and certificate automatically; no manual CNAME is needed. Otherwise add the domain as a Cloudflare zone, change the registrar's nameservers to those assigned by Cloudflare, wait for the zone to become active, then redeploy. The dashboard Worker must be deployed after edge so magic-link verification and API proxying use the new auth contract.

## 10. Executable go/no-go

Run from the repository root after deployment and ops login/password-change verification:

```bash
bash infra/staging-check.sh
```

Useful variants:

```bash
bash infra/staging-check.sh --skip-live   # config/resources only; not rehearsal approval
bash infra/staging-check.sh --allow-stub # infrastructure-only; never paid/hybrid approval
```

The default strict gate checks:

- required state is present; paid mode uses Flutterwave **test** secret/public keys, `PAYMENTS_REQUIRED=true`, hybrid identity, and Smile ID sandbox;
- all five public Worker origins and the dedicated ops dashboard origin are distinct; callback, privacy, biometrics, identity reconciliation, and other public values have the required HTTPS relationships;
- staging TOML has no `example.com` or `set-with-wrangler` placeholders, has the expected public values and Hyperdrive/capture bindings, and has no deployed header-auth fallback; the generator leaves the top-level identity cleanup cron untouched;
- Cloudflare authentication and all six queues/DLQs, archive R2, hybrid capture R2, and Hyperdrive exist;
- every required secret **name** exists on each staging Worker, including all three hybrid identity secrets and Resend on edge;
- migration `0018` matches exactly, its schema exists, the launch market is seeded, and an ops admin exists;
- all five HTTPS health routes succeed, payments reports the selected dispatcher, the dedicated ops dashboard loads, the retired edge login returns `404`, and anonymous ops API access is rejected;
- archive internal reads reject anonymous/invalid credentials with `401`, and the valid shared credential reaches routing;
- payments rejects anonymous/invalid bank-directory credentials; paid mode also loads `/payments/banks` through edge, proving the edge→payments service-auth path and provider directory call;
- hybrid Smile ID callbacks through edge reject both missing and invalid signatures with exactly `401`; the privacy URL is reachable; biometrics reports its model version and rejects an invalid bearer token;
- `infra/reconcile.mjs --json --market="$LAUNCH_MARKET"` has no `FAIL` or `WARN`; paid mode also rejects a skipped vendor check.

The checker loads secrets only from the ignored staging state file and never prints them. It does not create, modify, deploy, migrate, or delete anything. **Any failure means NO-GO. Do not start a paid/hybrid human test until the unmodified strict command, without either flag, exits 0 and prints `GO`.** Infrastructure checks passing alone do not replace the session consent, test-data, photo-handoff, and stop-condition requirements in `first-live-test.md`.

### Honest limits of these checks

- Health and `secret list` do not prove shared secret values match, vendor credentials are valid for every operation, or a real enrollment can complete.
- Biometrics `/healthz` and `modelVersion` do not execute inference, benchmark accuracy/liveness, validate threshold choice, or prove `BIOMETRICS_INTERNAL_TOKEN` equals identity `BIOMETRICS_SERVICE_TOKEN`. The operator confirmation and a real sandbox enrollment remain necessary.
- Missing/invalid Smile ID callback tests prove rejection only. They do not prove a valid sandbox callback, job result, consent receipt, capture retention/deletion, or login/recovery succeeds.
- The paid bank-directory check proves the edge→payments authenticated path and that provider directory request; it does not prove charge confirmation, transfer webhooks, payout completion, refunds, or settlement execution.
- R2 existence/binding checks do not replace verifying private access and retention behavior with real sandbox artifacts.
- `--skip-live` omits every deployed HTTP assertion and therefore cannot approve a live rehearsal. `--allow-stub` is always infrastructure-only, even if real credentials also happen to be present.

## 11. Reconciliation and recovery

The strict checker runs reconciliation automatically. To inspect it separately with the same staging state:

```bash
set -a
source infra/.staging/.dev.vars
set +a
DATABASE_URL="$DATABASE_URL" FLUTTERWAVE_SECRET_KEY="$FLUTTERWAVE_SECRET_KEY" \
  node infra/reconcile.mjs --market="$LAUNCH_MARKET"
```

Any `FAIL` is a stop condition. The unexplained `WARN` budget is zero. Explain and resolve stale holds, pending dispatches, `refund-manual`, and `refund-review` before proceeding; never hide them by narrowing the market scope.

For an archived settlement with missing payment execution after queues drain, use Ops → Settlements → **Re-drive payments**. This re-enqueues canonical requests with unchanged idempotency keys; it does not assert provider completion. Use per-leg replay only after fixing the recipient/provider cause. Do not create a replacement settlement or issue an ad-hoc transfer. Follow `first-live-test.md` incidents I3–I3d for holds, re-drive, ambiguous refunds, and manual refunds.

## 12. Rollback

Rollback is a controlled traffic/code action, not permission to delete evidence.

1. **Stop paid/hybrid tests immediately.** Do not start new checkouts or enrollments. Record affected participant/job ids and affected run, settlement, hold, dispatch, and refund ids.
2. **Roll back edge first** to its previous Wrangler deployment. Keeping the new archive alongside previous edge is safe: temporary dual emission is idempotent under ADR-0029.

   ```bash
   npx wrangler rollback --config infra/wrangler.edge.toml --env staging
   ```

3. If required, roll back notifications, payments, identity, then archive, in that order, checking health and queue drain between steps. Do not roll archive back while leaving an edge version that depends on the newer archive contract. Keep the external biometrics service compatible with whichever identity version remains active.
4. **Do not automatically reverse database migrations.** Migrations through `0018` are part of the deployed schema; use a reviewed forward migration for any schema correction. Never drop Neon tables, queues/DLQs, or R2 evidence/captures to “clean up” an incident.
5. To disable paid checkout without a code rollback, set staging edge `PAYMENTS_REQUIRED="false"` and payments `PAYMENT_DISPATCHER="stub"` through the confirmed public TOML workflow, redeploy payments then edge, and mark paid scenarios not tested. To disable hybrid identity as well, select `FACE_VERIFIER="stub"` through that infrastructure-only workflow and redeploy identity; this removes hybrid-only public vars but is not a data-deletion procedure. Existing holds/refunds and retained captures still require reconciliation and honest completion.
6. Re-run `bash infra/staging-check.sh --allow-stub` for infrastructure recovery, run reconciliation, and keep strict paid/hybrid go/no-go blocked until Flutterwave test configuration, hybrid identity, and all money checks pass again.

If a deployment fails midway, keep the already-deployed archive, do not deploy an older edge over it as a first reflex, and use the failure output plus this rollback order to restore a compatible set. Record every action in the incident/session log.
