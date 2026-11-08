# Refund resolution is an audited, write-once execution decision

ADR-0025 made non-card refunds honestly manual and quarantined conflicting provider history as `refund-review`. Those states need an operator recovery path, but adding arbitrary refund writes would create a side-channel money decision. ADR-0030 instead adds **write-once resolution evidence and a narrow state transition**: operators can accept an existing provider refund, record a completed manual refund, or permit a reviewed retry. Amounts and settlement legs remain untouched.

## The command and its evidence

`POST /payments/refunds/:refundId/resolution` accepts a strict command with three variants:

- `accept-provider`: provider reference, processing/completed status, evidence reference, and note for a `refund-review` row.
- `complete-manual`: external/manual transfer reference, evidence reference, and note for a `refund-manual` row.
- `allow-retry`: evidence reference and note proving that a `refund-review` row may return to `failed` for canonical execution.

The edge derives `resolvedBy` from the authenticated admin identity; the payments worker owns `resolvedAt`. Browser-supplied actor fields, timestamps, amounts, run ids, idempotency keys, and payout legs are rejected. The public payment proxy does not expose the route; only the admin-only, service-authenticated, Ops-audited proxy reaches it.

Migration 0018 creates `payment_refund_resolutions`, keyed one-to-one with the refund and constrained by action/status/reference shape. The record is write-once: an identical fingerprint replays without changing evidence, timestamps, attempts, hold state, or queue history; a different fingerprint conflicts. A separate table is deliberate—later queue execution may change the refund's live provider reference or status, but it cannot rewrite the operator's evidence.

## Atomic state, hold truth, and retry

Accept/manual resolution commits the evidence, refund transition, provider reference, and hold accounting in one Postgres transaction. Existing processing/completed amounts determine `partially-refunded` versus `refunded`; attempts are not incremented because resolution is not a provider execution attempt. No provider or refund gateway is called from the HTTP route.

`allow-retry` requires the durable settlement and canonical refund before commitment. It commits `refund-review → failed`, then enqueues exactly the canonical `payment.refund-requested` with the existing idempotency key. Queue execution, not the HTTP route, remains the only provider-execution path. If enqueue fails, the resolution remains committed and the response reports `resolutionCommitted: true`; an identical request replays without another queue send. The Ops audit records the committed resolution even for that enqueue failure.

## Consequences

- `refund-review` and `refund-manual` are blocked for automation, not dead ends for oversight.
- Admin control does not become arbitrary money editing: the settlement still decides the amount, and retry still uses the canonical queue request.
- Resolution evidence survives subsequent execution and remains visible in refund reads and the Ops Refunds tab.
- Concurrent resolutions serialize to one apply; only an identical decision may replay.
