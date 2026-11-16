# Staging redeployment record — 16 November 2026

## Change set and commits

| Commit | Scope | Deployment significance |
| --- | --- | --- |
| `e30fb90` — Add participant history, retained media, and dedicated ops | Finite private product/intent media retention, buyer intent capture, archive cleanup cron and admin holds, ops/history/privacy changes | Migrations `0019`–`0021` were already on staging. Migration `0022` and the archive Worker were deployed in this run. The ops Worker was already current. |
| `d8e4cfd` — Add inbox attachment downloads and reply uploads | Site admin inbox attachments | Existing `origin/main` baseline; no Cloudflare Worker change in this run. |
| `6c18121` — Add versioned consumer policy acknowledgement | In-app consumer/refund policy, explicit onboarding and existing-participant acknowledgement, session transaction gate, durable acceptance history | Migration `0023` and the edge Worker were deployed in this run. Requires a new mobile staging build for the UI. |
| Deployment-record commit | This verified deployment summary and remaining launch inputs | Documentation only. |

No provisioning or checking `.sh` scripts were used. Drizzle and Wrangler were invoked directly.

## Database

From `infra/drizzle`, `npx drizzle-kit migrate` completed against staging Neon. Both new records in `drizzle.__drizzle_migrations` matched the local migration files by exact SHA-256, not merely by migration count:

- `0022_retained_media.sql`, journal timestamp `1794643963886`; `retained_media` exists.
- `0023_consumer_policy_acceptances.sql`, journal timestamp `1794791658341`; `consumer_policy_acceptances` exists.

The acceptance table has one durable participant/version row with a Postgres timestamp. Repeating an acknowledgement preserves the original row and timestamp.

## Cloudflare deployments

Archive was deployed before edge to preserve the archive/payment ordering rule:

- `market-runs-archive-staging`: version `f818f402-6d34-49ae-91b1-4635271bedda`; cron `17 * * * *`; archive queue consumer and notification/payment producers present.
- `market-runs-edge-staging`: version `e383c223-1ca3-4dbb-b615-e01c361528bd`; all five Durable Object namespaces, archive/identity/payments service bindings, queues and Hyperdrive present.

The identity, payments, notifications and ops Workers were not changed by the policy commit and were not redeployed. The site is deployed by its GitHub/Vercel integration when `main` is pushed.

## Verification evidence

- All workspace tests and type checks passed with `--workspace-concurrency=1`. Sequential execution is required because integration suites share the local Postgres test database; the initial parallel recursive run caused truncation races.
- Edge: 41 files / 226 tests passed. Mobile: 39 tests passed. Proto: 49 tests passed.
- Real local Postgres verification covered both migrations, one-row acceptance idempotency, and participant-profile projection; synthetic rows were removed.
- Archive and edge Wrangler staging dry-runs succeeded before deployment.
- All five backend `/healthz` routes returned `200`; payments reported `flutterwave`.
- Anonymous `/ops/api/overview` returned `401`; anonymous policy acceptance returned `401`; the dedicated ops dashboard returned `200` at `https://market-runs-ops-staging.leslie-bund.workers.dev`.
- A synthetic staging participant with a real Bearer session received `403 consumer-policy-acceptance-required` before acceptance, `200` on acceptance and retry, exactly one acceptance row, and `consumer-refund-v1` on its durable profile. Only those synthetic profile/acceptance rows were deleted afterward.

## Still open / not claimed by this deployment

- **Mobile release:** build and distribute a new staging app containing buyer intent media and the policy screen/acknowledgement flow. Worker deployment does not update installed Expo binaries.
- **Legal approval:** qualified Nigerian counsel must review `consumer-refund-v1`, participant contracts, complaint handling and the interaction between statutory remedies, the 30-minute settlement pause and ADR-0008. The policy does not itself change the settlement algorithm. General later-complaint handling is currently the published support email/manual review, not a new ticketing system.
- **Paid staging remains NO-GO:** the three pre-existing Flutterwave test payout legs failed for insufficient customer-wallet funds. They were not replayed, altered or hidden by this deployment. Fund the test payout balance and follow the existing canonical per-leg replay/reconciliation procedure before another paid rehearsal.
- **Ops custom domain:** `ops.marketruns.org` still needs the Cloudflare zone/custom-domain correction. The workers.dev dashboard is the verified route.
- **Backlog only:** buyer-supplied existing-media references, identity-verified badges, participant-specific suspension and RASP telemetry are not implemented. Fresh-camera rules for seller products and runner evidence remain unchanged.
- **Launch inputs:** the founder still needs to confirm the launch market and complete the legal/privacy/DPIA/vendor checks recorded in the compliance research and first-live-test runbook.
