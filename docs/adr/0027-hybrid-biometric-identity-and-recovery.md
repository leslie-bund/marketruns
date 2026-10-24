# Hybrid biometric identity: local 1:1, vendor KYC binding, and face-gated recovery

ADR-0022 originally alternated between self-held embeddings and vendor-held biometrics. This amendment replaces that either/or mode with a hybrid enrollment: one participant has an encrypted local embedding **and** a Smile ID `providerRef`. Smile ID performs Biometric KYC and identity binding; it does not return an embedding and is not on the repeat-login path.

## State and KYC

- `identity_participants.kyc_status` distinguishes staging `preverified` from real `verified`. Production proof issuance and enrollment require `verified`; the ADR-0004 production KYC gate is unchanged.
- `verifiedLegalName` is written once from a signed KYC result and is immutable. `displayName` remains editable. The completed enrollment job returns the vendor legal name as a suggestion for explicit display-name confirmation.
- Only the internal edge seam `POST /auth/enrollment-proof` can create/update an identity participant and issue a proof. Public enrollment cannot upsert a participant. The opaque proof is 256-bit random, SHA-256-hashed at rest, participant/purpose-bound, expires after 15 minutes, and is consumed by device-key registration.
- Device-key registration requires either a live same-participant session or that enrollment proof. Public device reset creation is gone; manual reset creation/decisions remain internal.

## Capture, hybrid enrollment, and login

Mobile captures seven fresh camera frames. Before capture or vendor submission it records explicit `biometric-capture-v1` consent, with a receipt persisted by the identity worker. Six to eight frames are required at every face capture boundary.

`POST /auth/face/enroll` validates the proof and invokes the private Node service for real multi-frame liveness plus a same-model 512-dimensional embedding. For hybrid enrollment, the identity worker encrypts that embedding into the pending job, submits Biometric KYC, and returns 202. A signed result or poll finalizes both `providerRef` and the local embedding. Pending embeddings are cleared at terminal transition; jobs expire after two minutes and expired/invalid callbacks fail closed. An authorized callback image is supported only as a temporary fallback if a pending embedding is absent; callback images are never persisted.

`POST /auth/face/verify` always invokes local fresh liveness, decrypts exactly the named participant's embedding, and performs in-memory 1:1 cosine matching. There is no email recovery, no 1:N identification, and no vector search. `POST /auth/recovery` applies the same participant identifier + fresh liveness + 1:1 check, then revokes old device credentials and sessions before registering the replacement key and issuing a session. Five failed face attempts in 15 minutes trigger a 15-minute attempt window (429). Similarity remains banded in audit/wire responses.

## Private service and runtime honesty

`apps/biometrics` is a separate Dockerized Node service. Only `apps/identity` holds its bearer token; mobile and the marketplace edge cannot call it and there is no admin-key route. `FACE_MODEL_PATH` and `LIVENESS_MODEL_PATH` must name real ONNX artifacts. Missing artifacts, missing production secrets, stub mode in production, invalid model output, and failed liveness all fail closed.

The ArcFace and MiniFASNet preprocessing/inference structure was selectively adapted from `reference/bug-free-giggle` (`recognition/embedder.ts`, `liveness/antiSpoofing.ts`). No root LICENSE was present in the supplied reference repository. This is provenance, not a license grant; confirm redistribution permission before external distribution. Unrelated SDK, identification/1:N, API, and deepfake flows were not copied.

`FACE_MATCH_THRESHOLD` and `LIVENESS_THRESHOLD` are explicit runtime inputs. Existing 0.6 cosine and 0.8 liveness defaults are engineering placeholders, **not accuracy findings**. No accuracy, FAR/FRR, demographic-performance, or presentation-attack benchmark was run in this change; launch requires a versioned benchmark on the actual models, preprocessing, devices, and target population.

## Private capture handling contract

Raw JPEG frames exist in mobile memory, the TLS request to the existing edge `/auth/*` proxy, identity-worker request memory, and the TLS server-to-server request to the biometric service. The edge proxy must remain body-forwarding only: no capture logging, analytics, persistent request bodies, or media-library upload. Identity and biometrics do not write raw frames to Postgres, R2, logs, or responses. Provider submission follows the recorded consent and Smile ID's own retention terms. Only encrypted embeddings, consent receipts, banded attempts, provider references, and session/credential metadata are retained. The pending encrypted embedding is deleted when the job terminates. Production deployments must set body-size limits and TLS at the proxy and use a private network for biometrics.

## Core integration left outside this branch

After existing edge onboarding KYC succeeds, core must call internal `POST /auth/enrollment-proof` with the same participant id, role, display name, and `verified` (or staging-only `preverified`) status, then include the returned opaque `enrollmentProof` in its onboarding response. It must not log that proof. The existing `/auth/*` proxy needs no route changes, but it must forward `PATCH` and `Authorization`, enforce capture body limits, and honor the no-capture-logging contract above. Core should map `preverified` distinctly rather than presenting it as fully verified before the Biometric KYC result.
