# Versioned consumer-policy acceptance

Market Runs presents a plain-language consumer, returns and refund policy in the mobile app and requires an affirmative acknowledgement from every participant. Acceptance is separate from identity/biometric consent. The current version is enforced for authenticated transactions; the 30-minute dispute window remains a fast settlement pause, never a limitation on statutory rights, and ADR-0008's internal partial-abort allocation yields where Nigerian law requires a fuller remedy.

`consumer_policy_acceptances` is the durable, append-only acknowledgement history. A participant/version pair is unique, so retries preserve the original Postgres timestamp. Policy wording is immutable under a version: any substantive change requires a new shared version, a fresh in-app acknowledgement, and no rewriting of earlier receipts. Header-authenticated development fixtures retain their existing bypass; deployed sessions must have a durable participant profile and the current acceptance.

## Consequences

- New onboarding carries the current policy version, while existing participants use a self-only acceptance endpoint before transacting.
- The acceptance record stores no IP address, user agent, raw identity document, or policy body; the immutable shared source identifies the accepted wording.
- The policy is a launch draft requiring qualified Nigerian counsel review. Its publication does not itself change settlement outcomes, add a general complaint-ticketing system, or certify legal compliance.
- A future policy version intentionally requires a mobile release and fresh acceptance; changing only the displayed wording without changing the version is a versioning bug.
