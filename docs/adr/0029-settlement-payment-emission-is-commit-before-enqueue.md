# Settlement payment emission is commit-before-enqueue, with canonical re-drive

ADR-0023 made payment dispatch execution-only, but RunDO originally sent archive and payment messages independently and swallowed payment-enqueue failures before deleting its storage. That created a permanent lost-payment path. ADR-0029 makes the existing archive queue the durable emission record: **the settlement commits before its payment requests are enqueued, and the archive message is acknowledged only after enqueue succeeds.**

## Commit → enqueue → acknowledge

RunDO now emits only `run.retired` and `settlement.released`. The archive consumer persists the whole valid batch in ranked order inside one Postgres transaction, with no acknowledgement or external queue send inside that transaction. After commit it loads each settlement joined to its archived run, uses the shared pure payment projection in `packages/domain/payment-execution`, and enqueues the applicable dispatch and refund requests. Only then does it perform notification delivery and acknowledge the archive message.

A payment or notification enqueue failure calls `message.retry()` without acknowledgement. The committed settlement and ledger remain intact; redelivery replays persistence idempotently and rebuilds byte-equivalent payment requests. Standalone settlement redelivery needs no sibling run event because market, buyer, and runner come from `runs_archive`. Archive queues have five retries and dead-letter queues so retry exhaustion is visible rather than deleting the only emission trigger.

The payment worker still authorizes every request against the durable settlement before execution. Duplicate archive emission, an ambiguous queue result, or a crash after enqueue but before acknowledgement therefore produces only safe replays with unchanged settlement and per-leg idempotency keys.

## Settlement-level re-drive

`POST /settlements/:settlementRecordId/redrive` on the payments worker loads the durable settlement and enqueues the same canonical requests. It accepts no client legs, recipients, amounts, or idempotency keys and never calls the provider directly. Dispatch and refund sends are attempted independently; the response reports `enqueued`, `partial`, `failed`, or zero-message `noop`, with per-message counts. This is queue recovery, not proof of payment completion and not a forced execution override.

The Ops console exposes the operation only to admins at `POST /ops/api/admin/settlements/:settlementRecordId/redrive`, with service authentication and an audit entry. Existing consumer rules remain authoritative: in-flight/completed dispatches no-op, terminal per-leg failures still require remediation and leg replay, and refund/hold failures retain their honest states. Ambiguous refunds reconcile against provider history before another attempt; conflicting history becomes `refund-review` and is skipped by both queue redelivery and settlement re-drive. ADR-0030 adds a separate write-once admin resolution: accepting existing provider/manual refunds updates hold truth atomically, while an approved retry commits evidence first and then uses this same canonical enqueue path.

## Deployment and consequences

Deploy the archive producer before removing the legacy edge producer. Temporary dual emission is idempotent; the reverse order creates an emission gap. No outbox table or migration is needed because the archive event plus committed settlement already supplies the durable retry record.

- RunDO storage deletion no longer depends on a best-effort payment send.
- A payment enqueue failure cannot roll back or permanently strand the settlement decision.
- Ops can recover a missing settlement execution request without reconstructing money-bearing fields or bypassing the settlement function.
- Exactly-once remains an idempotent-execution claim, not a claim that queues, providers, or networks are infallible.
