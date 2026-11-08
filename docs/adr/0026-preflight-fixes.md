# Pre-flight fixes: disputes persist at retirement, a test-mode transfer accelerator, and the checkout tombstone

Writing the first-live-test runbook (docs/runbooks/first-live-test.md) forced three honest looks at the system before real humans touched it, and three of them came back as gaps. This ADR records the fixes together because they share a posture: none of them changes a doctrine, each closes the gap in the shape the existing doctrine already implied. One sentence survives all three: **pre-flight findings get fixed in doctrine's direction, never around it.**

## Dispute persistence: the archive consumer now writes the disputes row

ADR-0019 wired the dispute record to the archive boundary (`run.retired` carries the `dispute { reason, raisedBy, evidenceRefs }` block) and recorded openly that nothing persisted it — the ops console's Disputes tab stayed empty. That follow-up is now closed: the archive consumer inserts the block into the Postgres `disputes` table, in the shape the rest of the persistence layer already uses:

- **Deterministic id** `<runId>:dispute` — one dispute per run, so queue redelivery replays and never duplicates (`onConflictDoNothing`, the same exactly-once-by-schema posture as the refund rail's unique `settlementRecordId`, ADR-0025).
- **FK-safe ordering** — the insert runs after the `runs_archive` row exists, because `disputes.run_id` references it.
- **New `reason` column** (migration 0009); `DisputeViewSchema` gained `reason` additively, so the console renders *why* alongside the evidence refs.
- Status starts `open` — the table's unresolved status; a null raiser (a dispute whose originator the run wire didn't carry) is recorded as `"unknown"`, not guessed.
- **Settlement resolves the dispute in the same transaction.** `settlement.released` sets `resolved`, the settlement id, `releasedAt`, ambiguity, and absorbed loss while preserving raiser, reason, evidence, and creation time. This applies to every settlement mode. A disputed settlement without a participant dispute block creates one deterministic, already-resolved Ops-originated row with empty reason/evidence rather than fabricated context; other modes never synthesize a dispute. Replay cannot reopen a resolved row.

In-flight disputes still appear only at retirement. That was true before and remains true now — but it is no longer a gap; it is simply the retirement-snapshot doctrine (ADR-0010) applied to disputes: live state lives in the RunDO, durable records materialize when the run retires.

## Flutterwave test-mode accelerator

Test-mode transfers against the provider's mock banks sit `pending` for ~10 minutes before the webhook lands — unusable inside a live session. The provider documents magic reference suffixes that force mock outcomes, and the payments worker now uses them, quarantined exactly where the vendor name already lives (`apps/payments/src/flutterwave/`, ADR-0009): with `FLUTTERWAVE_TEST_MODE` truthy, every outgoing transfer reference gets `_PMCKDU_1` appended (mock SUCCESSFUL in ~1 min), and the webhook match strips the suffix before looking the row up by provider alias. The failure variant `_PMCK_ST_FDU_1` is documented for manual failure drills.

The guardrails are the point: test-mode only, **never production**; the vendor name and its magic strings appear in no other folder; and the reconcile script's vendor check compares bare provider aliases, so the strip-on-match keeps the money tying out under test mode. *[Amended 2026-10-24: the reference being suffixed is now the short provider alias from ADR-0024's amendment, not the full idempotency key; reconcile matches on `payment_dispatches.provider_reference` with a legacy idempotency-key fallback.]*

## The checkout tombstone

The adversarial finding: a client that loses its checkout response and retries `checkout.requested` against a just-retired cart used to get a bare 404 — and a sufficiently unlucky retry could seed a second run. Retired carts now leave a minimal tombstone — `{ retired, cartId, runId, retiredAt }` — and a retry against a tombstoned cart answers **409 `cart-already-checked-out` with the runId**, so the client recovers its run instead of guessing. Never a second run; RunDO seed idempotency remains the second line of defense.

Doctrine comment, because it needs one: retirement still deletes DO storage (ADR-0010). The tombstone is not retained cart state — it is the receipt a client needs to recover its runId. It never resurrects the cart, never re-opens acceptances, and expiry retirement of a later cart in the same DO preserves a prior checkout tombstone rather than deleting it.

## Consequences

- ADR-0019's open follow-up — *nothing writes the Postgres `disputes` table yet* — is closed; that ADR is amended inline.
- The runbook's known limitation L2 shrinks to doctrine: the Disputes tab lights up at run close with reason + evidence, and in-flight visibility is the retirement-snapshot doctrine, not a defect.
- Session-day transfer lag drops from ~10 min to ~1 min under `FLUTTERWAVE_TEST_MODE`, with failure drills still available via `_PMCK_ST_FDU_1`.
- The checkout-retry adversarial finding is closed: a lost checkout response is recoverable by retry, and a retry can never seed a second run.
- One tunnel now suffices for the session: the edge proxies `/webhooks/*` to the payments worker and `/callbacks/*` to the identity worker as dumb pipes (signature/hash verification stays at the owning worker), so provider servers reach both workers through the edge tunnel the apps already use.
