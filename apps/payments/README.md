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
RunDO.releaseSettlement ── payment.dispatch-requested ──▶ payment-dispatch queue
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
  by RunDO when the settlement outcome carries buyerRefundKobo > 0) and
  release against the buyer's hold — never a payout leg (ADR-0023). Card
  charges refund through the provider's refund API (`processing` — card
  refunds settle in days); non-card methods have no API rail and are marked
  `refund-manual` for ops, honestly terminal. Same retry/backoff/DLQ posture
  as dispatches; one refund per settlement (UNIQUE settlement_record_id).

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

## HTTP surface (dev posture: trusted-internal, no auth)

Mirrors apps/archive's admin endpoints: the worker is reached through the
edge ops console (`/ops/api/admin/payments`, behind the ops guard) or a
Service binding in deployed environments. The exception is
`/webhooks/transfers`, which the provider must reach — it is the worker's
only authenticated route (secret-hash verified). Revisit the rest with
ADR-0015.

- `GET /healthz` — liveness.
- `GET /dispatches?runId=&status=&limit=&offset=` — ops read; zod-validated
  `PaymentDispatchView` list (`status` ∈ pending|sent|queued|failed|completed).
- `POST /dispatches/:id/replay` — re-executes a `failed`/`pending` dispatch
  through the dispatcher (same idempotency key, so a provider that already
  accepted the transfer collapses the retry). 409 when the row is already
  `sent`/`queued`/`completed`; 502 with the updated view when the replay
  fails again.
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

