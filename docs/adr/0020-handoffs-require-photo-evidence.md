# A handoff confirms only with photo evidence

ADR-0019 put handoff evidence on the wire and left one question open: whether a photo should be *required* to confirm. The owner has now decided — required. The rationale, recorded verbatim in spirit: "confirms cannot be photoless, it gives way for cheating." A photoless confirm is the hole a dishonest runner needs: the QR challenge proves a code was scanned, not that goods changed hands, and ADR-0007's evidence-first economics only work if every exchange point produces evidence. This ADR records the new confirm semantics; ADR-0019 is amended inline.

## The confirm state machine

- **Scan no longer confirms.** A successful QR scan records `scannedAt` and returns 409 `photo-required` — the stamp lands, the confirm does not.
- **Attaching a photo to a scanned handoff *is* the confirm.** There is no separate confirm call on the happy path; the photo is the act of confirmation.
- **An explicit confirm without a photo 409s.** No code path reaches `confirmed` without evidence.

## Auto-confirm is gated on the photo

The 3-minute auto-confirm (buyer silence = consent) fires **only when a photo is attached**. A photoless handoff past its deadline does not confirm and does not fail: it stays pending, re-arms every 3 minutes, and carries `awaitingPhoto: true` on the run wire so every party sees the gap plainly — the nudge-and-expose posture of ADR-0019, kept for the stuck case rather than the confirmed one.

## A run never settles photoless

Final delivery 409s while any handoff is unconfirmed. Since a photoless handoff can no longer confirm by any path — scan, explicit confirm, or auto-confirm — a run with a photoless handoff cannot reach final delivery, and therefore cannot reach settlement. The invariant is structural: no evidence, no money movement.

## The escape hatch stays human

A runner with a dead camera in a low-connectivity market stalls the run rather than settling it photoless. Ops settle (ADR-0017) remains the deliberate human escape hatch for that stuck handoff — an ops-settled close is a disputed-mode record, so the exception is visible in oversight rather than silent.

## Consequences

- ADR-0019's "nudge-and-expose" posture survives only in the pending state: exposure of the gap, never confirmation of it.
- The wire change is additive (`awaitingPhoto`); older clients ignore it and simply see the handoff stay unconfirmed.
- The 30-minute dispute window and settlement trigger are unchanged — they just became unreachable without a complete evidence trail.
- Camera failure is now a run-blocking operational event, accepted by the owner as the cost of closing the cheating hole; ops settle is priced as the answer.
