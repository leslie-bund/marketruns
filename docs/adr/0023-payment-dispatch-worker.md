# Payment dispatch is queue-driven execution — never a new money decision

ADR-0007 made the settlement function the only place money moves; ADR-0008 priced aborts. But until now settlement ended at a Postgres record: the ledger said who was owed, and nothing actually moved. This ADR records the missing half — `apps/payments` (port 8790), a payment dispatch worker — and the boundary that keeps it doctrinally clean: **dispatch is execution, never a decision.** The worker carries the settlement record's legs verbatim; it computes nothing, re-prices nothing, and cannot invent a transfer. A new money decision anywhere in this worker is a bug by definition.

## The flow

At settlement release, RunDO emits a `payment.dispatch-requested` queue message carrying the legs straight from the settlement record — seller payouts, runner payout, platform fee. The payments worker consumes it, and a `PaymentDispatcher` abstraction (ADR-0009, same doctrine as KYC and face verification) executes each leg against a provider. The shipped implementation is `StubDispatcher`, which returns deterministic `stub:<sha>` references — enough to exercise idempotency, retries, and the ops surface end to end before a PSP is chosen.

## Refunds stay on the hold

Buyer refunds are **deliberately not dispatched.** A refund is not a payout; it is a release against the buyer's existing hold, expressed as `payment.funds-released` — a hold/capture integration concern that lands with the PSP integration, not a transfer the dispatcher executes. The dispatch queue carries only legs that push money *out*.

## Idempotency is structural, not remembered

`payment_dispatches` (migration 0005) makes exactly-once a database fact rather than a coding habit:

- Per-leg idempotency keys, `settlement:<id>:leg:<n>` — replaying a settlement replays nothing twice.
- The key column is `UNIQUE`; inserts are `onConflictDoNothing` — a duplicate delivery is a no-op by construction, not by check-then-act.

Retries use backoff up to `max_retries` 5, then dead-letter to `payment-dispatch-dlq`. The DLQ is deliberate and contrasts with the archive consumer, which has none — money execution gets a DLQ because a silently dropped payout leg is unrecoverable in a way a dropped snapshot is not.

## The ops surface

`GET /dispatches` lists, `POST /dispatches/:id/replay` re-executes a dead-lettered or failed leg (idempotency keys make replay safe), and the edge proxies a read at `GET /ops/api/admin/payments` into the ops console's new **Payments tab** — settlement money is now observable from decision to execution in one place.

## The vendor decision stays open — with the research recorded

*[Amended: decided in ADR-0024 — Flutterwave. `FlutterwaveDispatcher` lands in the vendor quarantine with per-leg idempotency mapped to the provider `reference`, a `completed` terminal status, webhook + poll tracking, and a `RecipientResolver` seam over payout details onboarding doesn't collect yet.]*

The PSP is undecided and this ADR deliberately does not decide it. What is recorded so the research isn't re-run:

- **Flutterwave transfers** — first-class transfer API with an `X-Idempotency-Key` header; maps cleanly onto the per-leg key scheme.
- **Paystack transfers** — transfers with reference-based dedupe; equally mappable.
- **Pandascrow** — a real Nigerian escrow API, but 3% fee and unlicensed in its own name.
- **Bachs** — a billing platform (bachs.io); no escrow or split product. Researched and eliminated.

One recommendation-shaped fact, stated as fact rather than decision: **self-ledgered settlement on Flutterwave or Paystack fits ADR-0007/0008 better than outsourced escrow or split-at-collection.** Splitting at collection pre-commits the money before the 30-minute dispute window closes, which is exactly the decision ADR-0007 reserves for the settlement function. The ledger-first design — hold, settle, then dispatch — keeps the dispute window intact; escrow vendors invert it.

## Consequences

- ADR-0007/0008 are untouched and reinforced: the settlement function remains the only money decision; dispatch is a faithful executor with no arithmetic of its own.
- Money movement now has the observability ADR-0017 gave runs: an admin read path, a replay mechanism, and a DLQ for the failures retries can't absorb.
- Idempotency keys are sized for the future PSP (`X-Idempotency-Key` / reference dedupe both fit), so vendor landing is an integration-layer change, per ADR-0009's pricing.
- Buyer refunds wait on the hold/capture integration; until it lands, settlement release moves seller/runner/platform money only, and that gap is visible in the Payments tab rather than silent. *[Amended: landed in ADR-0025 — the refund rail executes `payment.refund-requested` against the provider for card charges and lands non-card refunds as honest terminal `refund-manual`.]*
