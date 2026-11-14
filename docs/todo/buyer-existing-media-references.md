# Backlog — Buyer existing-media references

**Status:** Proposed; not scheduled or implemented.

## Product decision to implement

Allow a **Buyer** to attach either a fresh camera capture or an existing image/video reference to an Intent. Existing media is optional and must never block posting an Intent.

Only buyers may attach existing media. Sellers must use fresh camera capture for Product media, and runners must use fresh camera capture for Handoff evidence. Existing seller/runner media has no upload path and must be rejected server-side.

An existing buyer attachment is a **reference**, not evidence of the supplied item's condition, authenticity, availability, pickup, or delivery. Sellers must confirm that their offered Product matches the buyer's reference.

## User experience

- Present **Fresh capture** as the default and **Add existing reference** as the second choice.
- Use the native iOS/Android system photo picker, with the narrowest available permission model. Do not use a WebView for this feature.
- Show a persistent label after upload and on seller discovery: **“Buyer-supplied existing reference — may be edited or captured earlier.”**
- Preserve drafts and attachments through ordinary validation retries. A failed optional attachment should offer removal/retry without discarding the Intent text.
- Keep the existing camera-only flow unchanged for sellers and runners.

## Implementation plan

1. **Amend doctrine before enabling the picker.** Update the camera-only ADR and privacy notice to distinguish fresh capture from buyer existing-media references. Record the purpose, recipients, and retention period.
2. **Extend capture metadata.** Add a server-validated source such as `fresh | existing` and retain the existing `intent` purpose. Do not infer trust from client-supplied labels alone; the edge assigns the authenticated buyer, purpose, and source policy.
3. **Add the native picker.** Confirm a compatible Expo picker dependency/version before adding it. Request no broad media-library permission when the operating-system picker supports picker-scoped access.
4. **Enforce role policy at the edge.** Only a session-authenticated buyer may upload an existing Intent reference. Product and run-evidence captures continue to reject existing media regardless of client headers.
5. **Validate and normalize media.** Enforce real decoding, allowed formats, byte/duration limits, and upload rate limits. Strip incidental metadata and re-encode where the confirmed toolchain supports it. Reject malformed or disguised files rather than trusting filename/MIME assertions.
6. **Use the existing retention path.** Expired Intent references follow the same private seven-day retained-media schedule and Media Hold mechanism. Keep capture reads scoped to the buyer and matching sellers.
7. **Add moderation telemetry.** Record validation failures, repeated rejected uploads, and relevant security signals for authorized ops review. RASP/root/tamper signals, if introduced separately, are risk telemetry only and never automatic proof, suspension, or a theft finding.

## Acceptance criteria

- A buyer can post an Intent with no media, fresh media, or existing media.
- Existing buyer media is visibly labelled for both buyer and matching seller.
- A seller cannot attach existing media to a Product; a runner cannot use it for a Handoff, including through direct endpoint calls.
- A modified client cannot turn an existing-media buyer upload into seller Product media or runner evidence.
- Existing media cannot be used to satisfy photo-gated Handoff confirmation.
- Media is private, validated, rate-limited, retained for the documented finite period, and covered by deletion/hold tests.
- Native permission behavior is verified on current iOS and Android without requesting unnecessary broad library access.
- Documentation and real-device tests distinguish buyer convenience from evidence freshness.

## Non-goals

- No WebView upload surface; it would not stop a modified app from calling the same endpoint.
- No seller catalog reuse or runner historical-photo upload.
- No claim that buyer references are fresh, authentic, tamper-free, or proof of fulfillment.
- No automatic scam/theft decision from RASP or media-validation signals.
