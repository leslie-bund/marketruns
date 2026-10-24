# Flutterwave is the payout dispatcher — chosen by the owner, quarantined by ADR-0009

ADR-0023 shipped the payments worker with a `StubDispatcher` and left the PSP decision open with the research recorded. The owner has now decided: **Flutterwave**. This ADR records the vendor landing — the `FlutterwaveDispatcher` implementation, the dispatch status lifecycle it forces, how disbursement outcomes are tracked, the recipient seam that papers over payout details the system doesn't collect yet, and where the secrets live. ADR-0023 is amended inline; its doctrine is untouched — dispatch remains execution, never a decision.

## The vendor boundary

Per ADR-0009, the vendor name appears only in the quarantine folder (`apps/payments/src/flutterwave/`) and the dispatcher selector (`PAYMENT_DISPATCHER=flutterwave`). Nothing in the domain model, the proto schemas, or the route layer knows who moves the money. `FlutterwaveDispatcher` speaks the Transfers API v3 and maps our per-leg idempotency key onto the provider's `reference` through a short deterministic alias — the dedupe scheme ADR-0023 sized for. A provider-side duplicate (same reference) collapses to the original transfer's status rather than erroring, so a retried leg converges instead of double-paying.

Two unit translations are pinned at the boundary:

- **Kobo → naira happens only here.** The domain and the ledger count kobo; Flutterwave counts naira. The conversion exists in exactly one file.
- **Transfer limits fail honestly, never clamp.** Flutterwave enforces ₦100 minimum / ₦1,000,000 maximum per transfer. A leg outside that band fails as a dispatch result — it is never silently adjusted, because adjusting a leg's amount is a money decision and money decisions belong to the settlement function alone (ADR-0007, ADR-0023).

## The status lifecycle

Dispatch status is `pending → queued → sent → completed | failed` (migration 0006 adds `completed`):

| Provider status | Dispatch status |
|---|---|
| NEW | `queued` |
| PENDING | `sent` |
| SUCCESSFUL | `completed` |
| FAILED (or unresolved recipient) | `failed` |

`completed` is the new terminal: a transfer Flutterwave confirms as landed. `failed` stays honest — nothing auto-retries into a terminal state, and anything failed or dead-lettered remains replayable through `POST /dispatches/:id/replay` (ADR-0023), safe because the idempotency key collapses provider-side.

## Tracking outcomes: webhook first, poll as fallback

A dispatched leg is not done when the API accepts it; it is done when the provider says the money moved. Two paths report that:

- **`POST /webhooks/transfers`** — the primary path. Verified against the `verif-hash` shared secret, compared as **constant-time SHA-256 digests**. Honest note, recorded plainly: Flutterwave's scheme is a *secret echo*, not an HMAC — the header is the shared secret verbatim, so the check proves the caller knows the secret, nothing more (no integrity, no replay protection). That is the vendor's scheme, accepted with eyes open and mitigated only by the constant-time comparison. The endpoint accepts both the v3 `transfer.completed` event and the v4 `transfer.disburse` shape.
- **`POST /dispatches/sync`** — the polling fallback, for the delivery gaps webhooks always have. It pulls provider status for non-terminal dispatches and folds them through the same mapping.

Both paths are idempotent at the database layer: a status re-arriving is a no-op, so webhook and poll can race without consequence.

## The recipient seam

The system does not yet collect payout bank details — onboarding captures identity (ADR-0022), not accounts. Rather than block payouts on that gap, resolution sits behind a `RecipientResolver` seam, and the shipped implementation is `DevRecipientResolver`: an env-provided JSON map plus Flutterwave's documented test accounts. An unresolved recipient fails honestly as `recipient-unresolved` — a terminal, replayable dispatch failure, never a guessed account and never a silent skip. Collecting real payout details in onboarding is the recorded follow-up; when it lands, only the resolver changes.

## Secrets

The Flutterwave test key lives in gitignored `infra/.dev.vars` (verified: wrangler reads it next to `--config`), switched on by `PAYMENT_DISPATCHER=flutterwave`. Production keys follow the standing rule — wrangler secrets, never committed. Honest note: Flutterwave test keys still hit the **production host**; the sandbox is the same API with test credentials, so a misconfigured environment variable in dev is a real call to a real endpoint with test money.

## Consequences

- ADR-0023's open question is closed; its doctrine stands. The settlement function is still the only money decision, and the dispatcher still computes nothing — limits fail, they don't clamp.
- Settlement money now moves end to end in dev: decision → queue → Flutterwave → tracked to `completed`, observable in the Payments tab, replayable at every failure stage.
- The recipient seam makes the missing onboarding data an explicit, honest failure mode (`recipient-unresolved`) rather than a blocker or a fudge; real collection is the follow-up that retires `DevRecipientResolver`.
- The webhook's secret-echo scheme is accepted as the vendor's design, documented here so a future reader doesn't mistake the comparison for an HMAC.
- **Scope stays payouts-only.** The pre-existing gap from ADR-0023 is unchanged: buyer collection and refunds — the `payment.funds-released` hold/capture side — remain unintegrated. Dispatch pushes money out; money coming in from buyers is still a stub concern, and that gap stays visible rather than silent. *[Amended: resolved in ADR-0025 — collection (server-side verified charges), holds with checkout gating (`PAYMENTS_REQUIRED`, dev off), the refund rail (card via provider; non-card → honest `refund-manual`), and seller payout accounts (resolve-then-save; the recipient seam is now DB-first). The `DevRecipientResolver` is demoted to env-map fallback.]*

## Amendment (2026-10-24): provider-reference alias

The first real Flutterwave dispatch surfaced a hard vendor limit: a transfer `reference` is capped at **64 characters**, while the canonical per-leg idempotency key is longer (`settlement:<settlementRecordId>:leg:<n>`; 66 characters for the e2e fixture, 75 with the ADR-0026 test-mode suffix). Flutterwave rejected every leg with `User ref should not be more than 64 characters` before creating a transfer.

**The fix is a provider-facing alias, not a change to the money model.** The local key remains canonical and unchanged in `payment_dispatches.idempotency_key`, the queue message, the settlement record, and the ledger. Each row also carries `provider_reference`, a deterministic alias:

```text
provider_reference = "mr_" + first 48 hex chars of SHA-256(
  "market-runs:provider-reference:v1:" + idempotency_key
)
```

That is 51 characters; the test-mode suffix adds 9, for 60 — inside the 64-character cap in both modes. The hash input includes the full leg key (including `:leg:<n>`), so distinct payout legs get distinct aliases. The alias is deterministic across queue redelivery, worker restarts, and ops replay.

Why not truncate the key? The keys share long prefixes (`settlement:run:cart:<market>:buyer:...`). Truncation can map two different payouts to the same provider reference; Flutterwave would collapse the second into the first, silently leaving a seller unpaid. A 192-bit hash makes that collision negligible, and a unique index on `provider_reference` turns any collision into a loud insert failure rather than a duplicate/missing payout.

### Matching and persistence

- `payment_dispatches.provider_reference` is nullable and unique. New rows persist the alias **before the first send**, so a webhook that races the HTTP response can still find the row. Existing rows stay `NULL` and use the legacy fallback.
- The dispatcher sends the alias (plus `_PMCKDU_1` only under `FLUTTERWAVE_TEST_MODE`).
- Inbound webhooks strip the test suffix, then match by `provider_reference`; legacy rows fall back to `idempotency_key`, then to `providerRef` (`flw:<id>`).
- Duplicate-reference collapse looks the original transfer up by the same alias.
- `infra/reconcile.mjs` ties provider transfers to `provider_reference` (legacy fallback: `idempotency_key`) and flags provider transfers carrying either our `mr_` or `settlement:` reference shape with no local row.
- `recordResult` persists the alias returned by the dispatcher, covering legacy rows on replay.

### Rollout and scope

The migration adds the column and unique index without backfilling: new dispatches get aliases, old rows keep the fallback. The current real attempts failed before Flutterwave created a transfer, so there is no provider-side transfer under an overlong full-key reference. The post-fix vendor tie-out confirmed this: 18 test-mode transfers, all `mr_` aliases, 0 provider orphans. If such a legacy transfer ever existed, it would need a one-time reconciliation before the alias switch; the webhook's `providerRef` fallback is the safety net for its eventual outcome.

No amount, recipient, settlement leg, hold, or ledger entry changes. The settlement function remains the only money decision; the dispatcher still executes verbatim legs. The alias is a vendor-boundary label.
