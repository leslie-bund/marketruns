# apps/payments — payment-dispatch worker

Queue-driven payout execution for released settlements. The settlement
function (packages/domain) is the ONLY place money is decided
(ADR-0007/0008); this worker merely executes the computed legs against the
payment service provider through the `PaymentDispatcher` seam (ADR-0009).
`StubDispatcher` is the zero-secret dev default; `FlutterwaveDispatcher`
(vendor quarantine: `src/flutterwave/`, the ONLY place the vendor name may
appear) runs real test-mode transfers when `PAYMENT_DISPATCHER=flutterwave`
— see infra/README.md "Flutterwave test-mode payouts".

## Flow

```
RunDO.releaseSettlement ── archive events ──▶ archive transaction commits
                                                   │
                                                   └── payment.dispatch-requested ──▶ payment-dispatch queue
                                                                                          │ (this worker)
                                                payment_dispatches rows ◀── persist ── consume
                                                          │                               │
                                                          └── ops reads (/dispatches)     └── PaymentDispatcher.dispatchTransfer(...)
                                                                                                │
                                                                          webhook /dispatches/sync converge in-flight rows
```

- **Idempotent**: per-leg idempotency key `settlement:<settlementRecordId>:leg:<n>`
  (unique column). Queue redelivery is a no-op replay — `sent`/`queued`/
  `completed` legs are never dispatched twice; `pending`/`failed` rows are
  retried. The provider receives a deterministic short alias
  (`provider_reference`, `mr_` + 192 bits of SHA-256, ADR-0024 amendment),
  persisted on the row before the first send; the full key remains canonical.
  A provider-side duplicate alias collapses onto the original transfer instead
  of double-paying.
- **Status lifecycle**: `pending` → `queued` (provider accepted) → `sent`
  (in-flight on the rails) → `completed` (settled at the destination,
  terminal) | `failed` (terminal, replayable). In-flight rows converge via
  the transfer webhook or `/dispatches/sync`; the synchronous stub reports
  `sent` and has nothing further to track.
- **Retries**: a failed leg calls `message.retry()` with exponential backoff
  (30s × 2ⁿ, capped at 600s). After `max_retries` (5, see
  infra/wrangler.payments.toml) the message lands in `payment-dispatch-dlq`
  and the row stays `failed` — visible via `GET /dispatches?status=failed`
  and re-runnable via `POST /dispatches/:id/replay`.
- **Buyer refunds** ride the same queue as `payment.refund-requested` (emitted
  by the archive after it commits a settlement with buyerRefundKobo > 0) and
  release against the buyer's hold — never a payout leg (ADR-0023, 0029). Card
  charges refund through the provider's refund API (`processing` — card
  refunds settle in days); non-card methods have no API rail and are marked
  `refund-manual` for ops, honestly terminal. Same retry/backoff/DLQ posture
  as dispatches; one refund per settlement (UNIQUE settlement_record_id).
  Ambiguous attempts reconcile through `GET /v3/refunds?id=<transaction-id>`
  before any new POST: exact provider matches are adopted, no accepted match
  permits one attempt, lookup failures retry lookup only, and conflicting
  history becomes `refund-review`, which automatic redelivery skips.

## Audited refund resolution

`POST /payments/refunds/:refundId/resolution` is the internal, service-authenticated recovery command for `refund-review` and `refund-manual`. It accepts only `accept-provider`, `complete-manual`, or `allow-retry`, with bounded evidence and references—never amounts, legs, client actor fields, or timestamps. The edge injects the authenticated admin id and the worker owns the timestamp.

Migration 0018's write-once `payment_refund_resolutions` table preserves action, status, provider reference, evidence, note, operator, and time. Identical decisions replay; different decisions conflict. Accept/manual updates refund and hold accounting atomically without incrementing attempts. Allow-retry commits the resolution before enqueueing exactly the canonical refund; queue failure leaves `resolutionCommitted: true`. No resolution route calls the provider.

## Collection: holds + checkout gating

The buyer's Flutterwave RN checkout completes client-side; the SERVER verifies
(`POST /payments/charges/confirm`, txRef-idempotent) and records a
`payment_holds` row. The edge gates checkout on the hold when
`PAYMENTS_REQUIRED` is truthy on the edge worker: `checkout.requested` must
carry `paymentRef` (the txRef); CartDO fetches `GET /payments/holds/:txRef`,
requires status `held` + matching cart/buyer + amount ≥ checkout total
(goods + delivery), and on pass binds the hold to the run
(`POST /payments/holds/:txRef/bind`) so the refund rail finds it by runId.

**Dev posture (default OFF)**: with `PAYMENTS_REQUIRED` unset, checkout is
unpaid and behaves exactly as before — demo flows and e2e tests need no PSP.
The stub dispatcher has no collection gateway, so the confirm/banks/
payout-account routes answer 503 `collection-unavailable` and refunds fail
honestly into the DLQ. A `charge.completed` webhook is a hint only — the
worker re-verifies with the provider before placing a hold (and needs
`meta: { cartId, buyerId }` on the charge to know whose hold it is).

## Payout accounts

`GET /payments/banks` (NG directory, 6h in-memory TTL), `POST
/payments/payout-accounts/resolve` (account-name enquiry, stores nothing),
`POST /payments/payout-accounts` (resolve-then-save — an unresolved account is
NEVER stored), `GET`/`DELETE /payments/payout-accounts/:participantId`
(revoke = soft delete). Saved accounts are the RecipientResolver's DB-first
source (`DbRecipientResolver`), ahead of the env-map and documented
test-account fallbacks; unknown parties still fail `recipient-unresolved`.

## Ops reads

`GET /payments/holds?buyerId=&runId=&status=` and `GET
/payments/refunds?holdId=&settlementRecordId=&status=` (admin-list shaped),
proxied by the edge at `/ops/api/admin/holds` and `/ops/api/admin/refunds`
next to the existing `/ops/api/admin/payments`.

`GET /recovery?market=` is the grouped stuck-settlement attention queue. It includes failed/pending dispatches, stale in-flight legs, failed/review/manual or stale-pending refunds, stale held holds, and canonical missing execution rows. Items are grouped by settlement and carry deduplicated replay/sync/resolution/redrive actions. It performs no provider calls, writes, queue sends, or notifications, and excludes ungated no-hold refunds. The admin-only Ops **Recovery** tab renders those actions through the existing recovery endpoints.

## HTTP surface and queue authorization

Every non-webhook route requires `x-payments-internal` when
`PAYMENTS_INTERNAL_TOKEN` is configured; deployed entry points fail closed
when it is absent. The explicit `ALLOW_HEADER_AUTH=true` local demo is the
only tokenless exception. `/healthz` remains public, and provider webhooks
keep their own secret-hash verification instead of service authentication.
The public edge proxy allowlists charge confirmation, banks, and
payout-account routes; holds, refunds, dispatch operations, and run binding
are internal-only.

Queue messages are not self-authorizing. Before any persistence, provider
call, notification, or hold transition, the worker loads the durable
settlement joined to its archived run and requires an exact canonical
request match. A not-yet-archived settlement retries without side effects;
a mismatch is rejected permanently. Existing rows and Ops replays must also
match the canonical settlement request.

- `GET /healthz` — liveness.
- `POST /settlements/:settlementRecordId/redrive` — rebuilds canonical requests
  exclusively from the durable settlement and enqueues them with unchanged
  idempotency keys. Never reads client legs or calls the provider directly.
  Returns enqueue-only `enqueued` (202), zero-message `noop` (200), or
  `partial`/`failed` (502) with per-message counts. Exposed to admins through
  `/ops/api/admin/settlements/:settlementRecordId/redrive`.
- `GET /dispatches?runId=&status=&limit=&offset=` — ops read; zod-validated
  `PaymentDispatchView` list (`status` ∈ pending|sent|queued|failed|completed).
- `POST /dispatches/:id/replay` — revalidates a `failed`/`pending` dispatch
  against its durable settlement, then re-executes it through the dispatcher
  (same idempotency key, so a provider that already accepted the transfer
  collapses the retry). 409 when the row is already
  `sent`/`queued`/`completed` or disagrees with the settlement; 502 with the
  updated view when the replay fails again. Successful replay also applies
  the queue's run-wide hold guard: at least one dispatch row must exist and
  every leg must be `sent`/`queued`/`completed`; pending or failed siblings
  keep the hold held and suppress the release notification.
- `POST /webhooks/transfers` — provider transfer outcome (terminal states).
  Verified against the configured webhook secret hash (401 on mismatch, 503
  when unconfigured); matches rows by `provider_reference` (the short alias
  sent to the provider), then legacy full idempotency key, then providerRef,
  and records `completed`/`failed` without bumping `attempts`. Unknown
  references are acknowledged as `unmatched` (200).
- `POST /dispatches/sync` — polling fallback: rows stuck `sent`/`queued`
  longer than `staleMinutes` (default 15; JSON body may override) are
  re-queried at the provider and converged. 501 `sync-unsupported` when the
  configured dispatcher cannot poll (the stub).
- `POST /dispatches/:id/sync` — authenticated single-dispatch polling using
  the same status-transition and notification logic as bulk sync; it never
  executes or replays the transfer and never increments `attempts`. Unknown
  rows return 404, unsupported dispatchers 501 `sync-unsupported`, and rows
  outside `sent`/`queued` 409 `not-stale`. A missing providerRef returns 409
  `unmatched`; a provider lookup miss returns 200 `unmatched` without
  mutation, consistent with bulk sync. Terminal outcomes return `applied`,
  while nonterminal outcomes return `unchanged` without mutation.

## Dispatcher contract

```ts
dispatchTransfer({
  idempotencyKey,                 // canonical local key, unchanged
  providerReference?,             // short alias persisted on the row
  recipient: { partyId, account },
  amountKobo,
  memo,
})
  → {
      status: "queued" | "sent" | "completed" | "failed",
      providerRef?,               // vendor transfer id
      providerReference?,         // alias actually sent (persisted by recordResult)
      failureReason?,
    }
```

A vendor implementation registers in `resolveDispatcher` /
`resolveDispatchIntegration` and is selected with the `PAYMENT_DISPATCHER`
var. That implementation and `src/flutterwave/` are the ONLY files where a
vendor name may appear (ADR-0009). Legs carry `partyId`, never bank details —
recipient coordinates resolve at the vendor boundary via `RecipientResolver`
(`src/recipients.ts`); unresolved parties fail honestly as
`recipient-unresolved` (replayable). Real payout-account collection in
onboarding is the documented follow-up.

## Database

Postgres (Neon via Hyperdrive in prod, `DATABASE_URL` in dev) — same
connection pattern as apps/archive (`db.ts`). Tables: `payment_dispatches`
(migrations 0005, 0006, 0011 adds `provider_reference`), `payment_holds`,
`payment_refunds`, `payout_accounts` (migration 0007). Money never lives in D1
(ADR-0011).

## Dev

Not yet wired into `infra/dev-all.sh` — run standalone:

```sh
DATABASE_URL="postgres://…" npx wrangler dev --config infra/wrangler.payments.toml --port 8790
```

For real test-mode transfers: `cp infra/.dev.vars.example infra/.dev.vars`,
uncomment the Flutterwave block and drop in your real test key (the template
is all-comments on purpose — a verbatim copy keeps the stub dispatcher),
restart (infra/README.md has the exact steps). `.dev.vars` is gitignored —
never commit keys.

