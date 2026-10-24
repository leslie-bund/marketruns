# Core integration for hybrid identity

1. After the existing edge KYC decision, call identity `POST /auth/enrollment-proof` over `x-identity-internal`. Use `verified` in production; `preverified` is staging-only.
2. Return the opaque `enrollmentProof` in the onboarding response alongside the same participant. Never derive it on mobile and never log it.
3. Keep the existing `/auth/*` proxy generic. It must forward POST, GET, and PATCH plus `Authorization`; do not add public enrollment-proof or biometrics-service routes.
4. Do not log, persist, trace, or send capture bodies to analytics. Forward them over TLS and enforce the agreed body cap (8 MB per image, 96 MB per request maximum).
5. Preserve `preverified` as visibly distinct from `verified`. Biometric KYC completion upgrades identity-owned KYC state; core should reconcile its participant/KYC read model from that result.
6. Mobile expects `enrollmentProof` from onboarding and forwards BVN/NIN type+number to hybrid enrollment. Production still requires the pre-existing verified KYC gate.
