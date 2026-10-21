# Passwordless face auth lives in an identity worker; sessions verify locally at the edge

ADR-0004 demands universal KYC before transacting, ADR-0009 puts identity vendors behind an internal abstraction, ADR-0015 keeps auth behind one middleware seam, and ADR-0016 landed the dev-stage versions of all three. Real authentication has now landed — partially, and by the owner's design: passwordless, face-first, with **no credential auth at all**. There is no password to leak, reset, or reuse. Onboarding is KYC → face enrollment → passwordless thereafter; fallback is a device-bound key (keychain/FIDO-shaped), and a lost device goes through an ops-approved reset. All of it lives in a new worker, `apps/identity` (port 8789), so the marketplace edge never touches a biometric.

## The enrollment/verify flow

- `POST /auth/face/enroll` — an **internal seam**, called by the edge after KYC succeeds, authenticated by `IDENTITY_INTERNAL_TOKEN`. The identity worker trusts the edge's KYC assertion; it does not re-verify identity.
- `POST /auth/face/verify` — the repeat login. On a match it issues an **HMAC session token, 12-hour TTL**.
- `POST /auth/session/validate` — introspection for callers that can't verify locally.
- `POST /auth/device-key/register` / `/authenticate` — a device-bound secret in expo-secure-store as the keychain/FIDO fallback path. `FIDO_UPSERT_ENABLED` is an env toggle that allows multi-device upsert **for dev testing only**.
- `POST /auth/device-reset` + `/decision` — a lost-device request goes to ops; approval revokes the participant's credentials and sessions.
- `GET /healthz`.

## Self-held, encrypted embeddings — and the tradeoff

The owner's design keeps the biometric in our own Postgres rather than a vendor's: embeddings are stored **AES-256-GCM encrypted at rest** (`face_enrollments`: bytea + iv + tag, migration 0004) and reused for every login. The tradeoff is recorded honestly: an encrypted embedding column gets **no pgvector `<=>` index**, so verification is decrypt-one-row + in-memory cosine. That is fine at pilot scale — one participant, one row — and the path back (decrypt-at-rest vendor, or plaintext + pgvector behind far tighter access control) is documented rather than pre-bought. Matching is a pure cosine matcher in `packages/domain/src/face-match.ts`; the threshold defaults to 0.6, is env-tunable, and **needs vendor benchmarking before launch** — 0.6 is a placeholder, not a finding.

Audit discipline: `face_auth_attempts` records **banded** similarity only. Raw scores never leave the server.

## The vendor seam, and what the research concluded

`FaceVerifier` is the ADR-0009 abstraction; `StubFaceVerifier` derives a deterministic 512-dim embedding via SHA-512 and is clearly labeled as having **zero security value**. `PasskeyVerifier` is stubbed too, but deliberately differently: gated behind `FIDO_STUB_ENABLED` it answers **501 by default rather than fake-verifying** — a fake-verify passkey path is how you ship a FIDO flow that never checks a signature, a bug class the owner has seen ship elsewhere and refuses to repeat.

Vendor research conclusion, recorded so it isn't re-litigated: **no researched vendor returns raw embeddings.** Smile ID (SmartSelfie Registration + Authentication, the deepest Nigeria coverage — BVN/NIN and friends) is the only vendor researched that covers both enrollment and repeat face login, but the biometric is **vendor-held**. The owner's self-held encrypted-embedding plan therefore shrinks the vendor's role to **enrollment-time liveness + identity binding**; anti-spoofing at login is our burden, priced as the cost of holding our own biometric. NDPA 2023 note: biometrics are sensitive personal data — explicit consent is required, and the consent copy is part of the enrollment flow, not an afterthought.

*[Amended: the vendor question this ADR left open is decided — **Smile ID**, owner decision. The owner has also reversed the biometric-custody stance this ADR priced: under `FACE_VERIFIER=smileid` the biometric is **vendor-held** and `face_enrollments` rows carry `providerRef` + `modelVersion="smileid-smartselfie-v3"` with **NULL embedding columns** (migration 0008) — the self-held encrypted-embedding tradeoff above now describes stub mode only. The integration lives in the `apps/identity/src/smileid/` quarantine (ADR-0009): token-based auth (`POST /v3/token` → JWT, 15-min TTL) with the legacy HMAC surviving only for **inbound** callback verification; endpoints `/v3/registration`, `/v3/authentication`, `/v3/biometric_kyc` (BVN/NIN — present but deliberately **not** wired into edge KYC yet; the integration point is `apps/edge/src/kyc/verifier.ts`), `GET /v3/status/:jobId`. The contract is async: enroll/verify return **202 { jobId, pending }**, clients poll `GET /auth/face/job/:jobId` (complete → session for auth jobs; 401 face-mismatch), and the production path is the signed callback `POST /callbacks/smileid`. `FACE_VERIFIER=smileid` without keys throws at startup. Env: `SMILEID_PARTNER_ID` / `SMILEID_API_KEY` / `SMILEID_ENV` (default sandbox) / `SMILEID_CALLBACK_URL` / `SMILEID_PRIVACY_NOTICE_URL` (NDPA consent). Mobile handles both sync (stub) and async (202 → poll) modes. Honest launch blockers: production liveness needs 6–8 frames and the wire captures one today; local jobs never expire and need a sweeper.]*

## Sessions verify locally; revocation lag is accepted

Session tokens are HMAC-signed and the verification key is shared in `packages/domain/src/session-token.ts` (pure). **The edge verifies tokens locally — no round trip to the identity worker.** An identity outage can degrade logins but cannot take down the marketplace. The cost is revocation lag: a revoked session stays valid until expiry. That lag is accepted deliberately and mitigated two ways — the 12-hour TTL, and the `auth_sessions` registry that `/auth/session/validate` consults for callers that need the authoritative answer. The edge trusts the signature; ops tooling can check the registry.

## Dev-stage trust seams, enumerated honestly

- Face enrollment trusts the edge's KYC assertion via a shared internal token — a network-segmentation boundary, not a cryptographic one.
- The edge's header identity (`x-participant-id` / `x-participant-role`) is **retained for dev** alongside Bearer sessions; `resolveParticipant` accepts either, tagged by source (`"session"` vs header). ADR-0015's seam absorbed real auth exactly as designed.
- `FIDO_UPSERT_ENABLED` and `FIDO_STUB_ENABLED` are dev-only toggles; both default off in any deployed posture.
- Mobile falls back to AsyncStorage for the device key on web and **flags it insecure** in the UI rather than hiding it.
- 401 session-expired self-heals to a signed-out state on the client; demo mode is untouched.

## Consequences

- ADR-0015's promise held: real auth landed and only `resolveParticipant` changed on the edge; routes and guards are untouched. The change is recorded here and amended inline there.
- The identity worker is a second writer to the shared Postgres (migrations stay centralized in `infra/drizzle`); the domain model still speaks no vendor names.
- A vendor swap replaces `FaceVerifier` — but the self-held embedding means the *vendor decision no longer decides where biometrics live*. That decision is now ours, with NDPA 2023 consent obligations attached.
- Threshold tuning (0.6 → benchmarked) and enrollment-time liveness vendor selection are **open inputs for launch**, on the same footing as the PSP keys in AGENTS.md. *[Amended: vendor selection is no longer open — Smile ID, per the amendment above. Threshold benchmarking and the recorded launch blockers (liveness frame count, job sweeper) remain open.]*
- Device reset is deliberately human: ops approval revokes credentials and sessions, so a stolen phone is an ops ticket, not a self-serve hole.
