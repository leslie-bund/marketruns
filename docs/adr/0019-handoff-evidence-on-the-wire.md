# Handoff evidence rides the run wire, and disputes carry their evidence with them

ADR-0007 made dispute resolution evidence-first: signed photos, scan logs, and GPS trail decide before any human review, and better evidence shrinks the ambiguous-loss bucket the platform absorbs. Until now the evidence layer existed only inside the RunDO — photo refs were captured and stored, but never serialized, so no client could render a handoff photo and a dispute arrived with a reason and nothing else. This ADR records the wiring that makes the evidence layer real: handoff evidence on the run wire, server-side evidence merge on dispute, evidence in the retirement snapshot, and the deliberate decision that a photo is not required to confirm *[Amended: reversed — photo required, ADR-0020.]*.

## Handoff evidence is serialized at one point

`RunHandoffSchema` (`packages/proto`) gained five additive optional fields: `photoCaptureRef`, `photoCapturedAt`, `scannedAt`, `confirmedAt`, and `autoConfirmed`. RunDO emits them from `wireHandoffs()`, the same single-emission-point pattern ADR-0018 established with `wireRun()` — every `run.updated` funnel carries the evidence, and older clients ignore the new fields. A buyer watching a run sees each seller pickup and the final delivery land with the runner's photo thumbnail as it happens, and keeps seeing them through the 30-minute dispute window.

## Dispute evidence merges server-side; retirement carries the whole record

`DisputeRunRequestSchema` accepts `evidenceRefs`, but the client is not trusted to enumerate them: RunDO merges every handoff photo ref it holds into the dispute record server-side. A buyer-side dispute therefore sends every visible photo ref by construction — no cherry-picking, no omission. `RunRetiredSchema` additively carries the `handoffs` (refs plus scan/confirm timestamps) and a `dispute { reason, raisedBy, evidenceRefs }` context block, so the evidence survives retirement into the archive boundary rather than dying with DO storage.

## A photo is not required to confirm — open decision

The server does not require a photo for confirm, and this is deliberate, not an oversight: the 3-minute auto-confirm (buyer silence = consent) must be able to complete photoless, so photo-optional confirm is structural, not just a runner shortcut. The runner is prompted to capture evidence immediately after a successful scan, and a photo remains attachable before *or* after confirm. Where a handoff confirms without a photo, the buyer's evidence section says so plainly — "confirmed without photo evidence" — rather than implying coverage that doesn't exist.

**Whether photo should become required for confirm is an open product decision, recorded here as undecided.** The current posture is nudge-and-expose: prompt the runner, show the buyer the gaps. Requiring a photo would harden the evidence layer (ADR-0007's profit-center logic argues for it) but would break photoless auto-confirm and punish runners for camera failures in low-connectivity markets. Decide before launch; the wire and UI already support either answer. *[Amended: decided in ADR-0020 — a photo is required to confirm. The scan records `scannedAt` and answers 409 `photo-required` until evidence lands, attaching the photo is the confirm, and auto-confirm fires only with a photo attached, so a photoless handoff stays pending past its deadline. Owner's rationale: photoless confirms give way for cheating.]*

## Consequences

- **Nothing writes the Postgres `disputes` table yet.** Dispute data now reaches the archive queue boundary inside `run.retired`, but the consumer does not persist dispute rows, so the ops console's disputes tab stays empty until that lands. FK ordering requires the insert to happen after the retirement row exists. *[Amended: landed in ADR-0026 — the consumer inserts `<runId>:dispute` after the retirement row (FK-safe), idempotent on redelivery, with a new `reason` column; in-flight disputes appearing only at retirement is now the retirement-snapshot doctrine, not a gap.]*
- `GET /captures/:key` remains open by unguessable-UUID key — the dev posture of ADR-0015, tightening when real auth lands.
- Steganographic media signing stays post-MVP (ADR-0013); until it ships, photo refs are evidence of capture, not proof of tamper-free provenance.
- GPS stays run-level, not stamped per handoff; ADR-0007's GPS trail remains implicit in the run's location stream rather than attached to each exchange point.
- The evidence layer ADR-0007 priced as a profit center is now observable end to end: captured in RunDO, rendered to the buyer, merged into disputes server-side, and carried through retirement.
