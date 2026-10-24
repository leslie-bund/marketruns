# Dev-stage onboarding, makeshift KYC, and the participant registry

ADR-0004 demands universal KYC before transacting; ADR-0014 deferred durable
identity anchoring to a founder decision; ADR-0015 keeps auth behind one
middleware seam. This ADR records the dev-stage landing of all three so the
app exercises the real flows before vendors and sessions ship.

## Decisions

- **Onboarding flow**: role → profile (display name + market) → document KYC
  (BVN or NIN, email, and explicit consent) → direct identity face enrollment.
  One move: `participant.onboarded` joins the first market when eligible;
  sellers continue into store registration.
- **Makeshift KYC**: an `IdentityVerifier` seam (`apps/edge/src/kyc/`) — the
  dev implementation accepts only 11-digit BVN/NIN and returns `preverified`
  solely with explicit `ALLOW_HEADER_AUTH=true`; otherwise a shape-valid
  document remains `pending` for real asynchronous KYC. It never returns
  `verified`. Raw document numbers are in transit only; the registry stores
  keyed HMAC-SHA256 hashes. Biometric frames are transit-only through identity,
  never onboarding R2 captures (ADR-0028). Vendor integration replaces the
  verifier seam (ADR-0009).
- **Auth**: the app attaches `x-participant-id` / `x-participant-role` from
  the onboarded identity — the exact dev-stage resolution ADR-0015 records.
  `/command` adoption narrows buyer attribution to the server-asserted caller
  when the wire omits `buyerId`; demo identities remain as explicit fallbacks
  for unonboarded exploration.
- **Participant home**: a fifth Durable Object, the global ParticipantDO
  registry. ADR-0014's Postgres-anchoring question stays open; the registry
  swaps homes without a wire change. *[Amended: the registry is rekeyed per
  participant — `participant:<id>` objects, O(1) per request; the single
  global blob hit the 2MB storage wall. A read-only legacy fallback serves
  pre-rekey dev state. See AGENTS.md state mapping.]*
- **Markets**: a zone registry (KV index, self-healing on join) backs the
  market list every role joins from. Geohash cells remain rejected as the
  market axis (ADR-0001); an ops admin portal for zones is v2. *[Amended:
  the zone portal shipped in ADR-0017 by owner decision.]*

## Consequences

- The full participant lifecycle — onboard, verify, join, transact — is
  exercisable on devices today.
- PII discipline is structural: keyed document hashes and consent receipts
  persist, raw BVN/NIN and biometric frames never do. Legacy capture-reference
  fields remain readable only for pre-ADR-0028 records; new onboarding does
  not populate them.
- When real sessions/vendor KYC land, the change surface is `resolveParticipant`
  plus the verifier implementation — recorded here so that decision is made once.
