# Production identity, presence, notifications, and operations decisions

This ADR records a set of owner decisions made together before production launch. They refine ADR-0013's MVP posture and supersede conflicting interim or amended implementation notes without rewriting the historical record. The boundary remains the one set by ADR-0007 through ADR-0012: identity and payment vendors stay behind seams, money moves only through settlement, and each kind of state has one home.

## Verification states and the production KYC gate

**Decision:** `preverified` and `verified` are distinct states. `preverified` is a staging convenience that permits controlled non-production testing; it is not evidence that identity verification succeeded and must never be presented as verified. Production transactions are gated on `verified` KYC. A participant who is absent, pending, rejected, expired, or merely preverified cannot transact in production.

**Rationale:** a test shortcut must not silently become a production assurance level. Keeping the states distinct makes audit output and authorization checks honest.

## Hybrid face custody and comparison

**Decision:** production uses a hybrid biometric design. Smile ID Biometric KYC performs enrollment liveness and identity binding and supplies a `providerRef`. We compute our own embedding with the **same model** used for subsequent comparisons solely from the recent submitted device selfie, store that embedding encrypted in our own Postgres record, and retain exactly one current approved enrollment selfie in identity-owned private R2 until replacement or account deletion. Provider-returned images never create embeddings. Rejected, failed, or expired pending captures are promptly deleted rather than enrolled.

Authentication is participant-keyed **1:1** comparison against the enrolled encrypted embedding. We do not perform **1:N** identification or population search. The provider reference supports verification lifecycle and vendor operations; it does not replace our local template. Encryption at rest, access controls, consent, retention, and deletion propagation apply to the template as sensitive personal data.

**Rationale:** the owner chooses local control of repeat authentication while retaining vendor identity verification and liveness. Same-model recomputation avoids treating embeddings from different models as interchangeable. This decision supersedes the vendor-held-only posture in ADR-0022's amendment; ADR-0022 remains unchanged as history.

**Constraints:** pending capture retention is bounded by terminal cleanup, two-minute job expiry, and scheduled sweeping. Routine login/recovery stays local; vendor SmartSelfie Authentication is reserved for a separately implemented high-risk step-up policy. Matching thresholds and liveness performance still require production benchmarking. No claim is made that liveness or matching is infallible.

## Internal runner pool claims atomically

**Decision:** the launch delivery supply is an **Internal Runner Pool**. Assignment is an atomic claim: once one internal runner claims a run, competing claims fail and no second runner can acquire it. The claim is tied to the run's state transition and is idempotent for retries by the same runner.

**Rationale:** a floor-rate option is not sufficient if two runners can both believe they own the same trip. The internal pool preserves the one-runner-per-cart doctrine without introducing the v2 trip auction.

## Seller presence uses a 60-second heartbeat

**Decision:** sellers emit presence heartbeats every **60 seconds** while active. Heartbeats are deduplicated so retries and repeated delivery do not create duplicate presence transitions, notifications, or durable records. Presence is derived from the accepted heartbeat window and expires when heartbeats stop.

**Rationale:** seller availability needs a lightweight liveness signal, not a continuously growing event log or an assertion that a device is reachable at every instant.

## Markets are database-backed and initially CLI-seeded

**Decision:** markets are durable database records, not configuration-file-only entries. The initial market catalogue is seeded through a controlled CLI workflow. Runtime reads use the database-backed registry; subsequent administration must preserve stable market identity and auditability.

**Rationale:** market identity anchors stores, discovery, runs, and archive records. A real registry is needed before those references can have consistent operational ownership. The founder still supplies the launch market name; this ADR does not choose it.

## Better Auth is ops-only

**Decision:** Better Auth may protect the operations console and operations identities only. It is not the participant authentication system and does not replace participant sessions, device credentials, face verification, or recovery.

**Rationale:** staff administration and participant authentication have different trust and recovery models. Sharing a library must not collapse that boundary.

## Notifications are durable in-app, realtime WebSocket, and email

**Decision:** notifications have durable in-app records, realtime delivery over authenticated WebSocket connections, and transactional email through Resend. WebSocket delivery is best-effort when connected; disconnection does not erase the durable in-app record. Email covers receipts, security notices, and approved service communications. **Expo Push is not integrated yet**, and no push-delivery guarantee is made.

**Rationale:** important events need a durable destination rather than depending on an open socket. Email adds a useful off-session channel without prematurely adding mobile-push tokens and providers.

## Recovery requires participant identifier and face

**Decision:** participant recovery requires the participant identifier plus a successful face verification against that participant's enrolled template, followed by the applicable credential/session revocation controls. Email is for receipts, security notices, and support—not a standalone recovery or credential-reset channel.

**Rationale:** possession of an email inbox is not sufficient evidence to restore a face-first account. Keying recovery to the participant also preserves 1:1 comparison and avoids biometric population search.

## Expanded operations management and telemetry preserve money and evidence

**Decision:** the operations surface expands to cover the participant, market, run, payment, notification, and service-management workflows needed for launch. Durable Object telemetry may expose object identity, lifecycle, timers, queue/alarm health, state transitions, and bounded operational metrics required for diagnosis.

Operations privileges do not permit arbitrary mutation of money or evidence. Settlement amounts, ledger effects, payment records, handoff photographs/references, QR scan/confirmation facts, and dispute evidence are immutable through the console: corrections require controlled append-only records or the existing settlement/dispute process, with actor, timestamp, reason, and before/after audit context where applicable. Telemetry must not dump raw biometrics, BVN/NIN, secrets, full evidence payloads, or unbounded live state.

**Rationale:** launch operations need leverage and observability without creating a back door around ADR-0007, ADR-0019, or ADR-0020. “Immutable” here governs operational mutation; it does not override a lawful deletion obligation.

## Consequences

- Production authorization must treat `preverified` as insufficient, while staging configuration and test fixtures must label that bypass explicitly.
- ADR-0022's amended vendor-held-only biometric posture is superseded by the hybrid local encrypted embedding + `providerRef` design. The launch blockers recorded there still require closure or an explicit new owner decision.
- Privacy copy, consent capture, deletion workflows, and vendor contracts must reflect one-current-selfie retention, transit-only login/recovery, 1:1-only matching, and biometric retention through replacement or account deletion subject to law. Account-deletion propagation remains an implementation requirement recorded in ADR-0028.
- Runner assignment, seller presence, market administration, notification delivery, and recovery need tests for retries, duplicate delivery, expiry, and wrong-participant access.
- Initial market seeding does not decide the open launch-market name in ADR-0013.
- Better Auth credentials are operations credentials; participant authorization remains behind `resolveParticipant` and the identity worker.
- No Expo Push dependency or push token collection is implied. Adding push later requires an additive notification decision and privacy-notice update.
- Operations expansion must be reviewed against least privilege and audit requirements. It cannot introduce direct money edits, evidence replacement, or telemetry endpoints that expose sensitive payloads.
