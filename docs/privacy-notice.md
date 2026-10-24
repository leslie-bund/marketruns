# Market Runs Nigeria Privacy Notice

> **DRAFT FOR OWNER REVIEW — NOT FOR PUBLICATION**
>
> This draft describes the intended production service. Owner approval, legal review, processor confirmation, and verification against the deployed configuration are required before publication. Square-bracketed items are owner inputs, not completed notice text.

**Effective date:** [OWNER INPUT: publication/effective date]  
**Controller/legal entity:** [OWNER INPUT: full legal entity name and registration details]  
**Contact address:** [OWNER INPUT: physical or postal address in Nigeria]  
**Privacy contact:** [OWNER INPUT: privacy email and telephone number]  
**Data Protection Officer/contact, if applicable:** [OWNER INPUT: name or role and contact details]

## 1. About this notice

Market Runs Nigeria (“Market Runs”, “we”, “us”) operates an errand marketplace in Nigeria. Buyers post requests for goods, sellers make offers, and runners collect and deliver accepted items. This notice explains how we handle personal data when people browse, register, verify their identity, trade, complete runs, contact support, or use our operations tools.

It applies to **buyers, sellers, runners (including internal runners), store or business representatives, muster-point personnel, and operations personnel** (together, “participants”). Different features apply to different roles. This notice does not replace a separate notice given to employees, contractors, or operations personnel where one applies.

## 2. Data we collect and why

The data we handle depends on a participant's role and actions.

| Category | Examples | Main purposes |
|---|---|---|
| Account and role data | Participant identifier, role, display name, account status, joined markets, device credentials, session and login records | Create and secure accounts, provide role-specific features, prevent abuse, and maintain audit records |
| Verified identity data | Verified legal name, date of birth or other attributes returned by the identity provider where applicable, verification status, BVN/NIN-derived keyed hash, and provider references | Verify identity, meet applicable requirements, prevent duplicate or fraudulent accounts, and support account recovery |
| Contact data | Email address and support correspondence | Send receipts and security or service notices, respond to enquiries, and resolve disputes |
| Marketplace data | Intents, offers, negotiations, carts, shop items, stores, market activity, reputation signals, and seller presence/heartbeat data | Match buyers and sellers, operate markets, coordinate checkout, and maintain marketplace integrity |
| Payment and payout data | Charge and transaction references, amount, currency, payment method, hold/refund/payout status, seller bank and payout-account details, and settlement records | Confirm payment holds, calculate settlement, execute or record refunds and payouts, reconcile accounts, and investigate fraud or disputes. Payment providers process card or bank credentials under their own notices; we do not need full card numbers to operate settlement records |
| Location and run data | Delivery or collection address, muster point, pickup and drop-off coordinates, route estimates, runner location stream, timestamps, and run status | Route and price runs, coordinate collection and delivery, show run progress, protect participants, and investigate incidents |
| Handoff and dispute evidence | One-time QR challenge/scan records, handoff photographs, capture references, scan/confirmation timestamps, dispute reasons, and supporting records | Confirm exchange points, establish chain of custody, resolve disputes, and protect against fraudulent claims |
| Biometric data | Multi-frame selfie/face capture, liveness results, an encrypted face embedding (biometric template), comparison outcomes, and provider job references | Bind a verified identity to an account, authenticate the participant, support face-based recovery, and detect spoofing or impersonation |
| Device, technical, and operations data | IP address, device/app and session information, logs, security events, notification records, operational actions, and service telemetry | Deliver the app and notifications, diagnose faults, secure the service, and audit operations activity |

We use this data to perform the participant contract, comply with applicable law, protect the service and participants, and pursue legitimate interests such as fraud prevention and service security, balanced against participant rights. Where the law requires consent—particularly for biometric processing—we will request it separately and prominently. [OWNER INPUT/LEGAL REVIEW: confirm the lawful basis for each processing activity and any required consent wording.]

### BVN and NIN

Where required for identity verification, we collect a Bank Verification Number (BVN) or National Identification Number (NIN) and submit it to our identity-verification provider. Our service creates a **keyed hash** for duplicate-account and integrity checks. After submission to the provider, our service does **not retain the raw BVN or NIN**, except where a specific legal obligation or approved workflow expressly requires otherwise; any exception must be disclosed before that workflow launches. The provider may retain submitted data under its own contract, notice, and legal obligations.

Raw identifiers must not be written to application logs. A keyed hash reduces direct exposure but remains personal data and is protected accordingly.

### Verified legal name and display name

A **verified legal name** returned through identity verification is used for identity, compliance, payment, security, and dispute processes. It is different from a **display name**, which is the name shown in marketplace interactions. A display name does not replace or alter the verified legal record. [OWNER INPUT: confirm exactly when legal names are visible to other participants, payment providers, and operations personnel.]

### Email is not a recovery channel

We use email for receipts, security notices, service communications, and support correspondence. **Email is not used, by itself or with a reset link, to recover an account or reset face/device credentials.** Account recovery requires the participant identifier and a successful face check, followed by the applicable security controls. Do not send BVN, NIN, identity documents, or selfie images by ordinary email.

## 3. Face capture, liveness, and identity verification

Enrollment and authentication may capture **multiple face frames** and perform liveness checks to help establish that a live person is present and to reduce spoofing. Market Runs uses **Smile ID** for identity verification and related liveness/identity-binding services.

Our production design is hybrid:

- Smile ID performs the applicable verification and returns a provider reference and verification results.
- We may temporarily retrieve the submitted selfie from Smile ID to compute **our own face embedding using the same model** used for later comparisons.
- The temporary selfie copy is deleted after that processing step, subject to confirmed job-completion and failure-cleanup behavior. [OWNER INPUT: confirm the maximum temporary-retention period and cleanup/audit implementation.]
- We store our embedding encrypted in our biometric service/database and associate it with one participant. Verification is **1:1**: a newly captured face is compared with that participant's enrolled template. We do **not** use the embedding for 1:N identification or to search a population to discover who someone is.
- Similarity and liveness outcomes are used for access and security decisions. Authentication and anti-spoofing controls are risk-reduction measures, not guarantees that every impersonation attempt will be detected.

Rejected, failed, abandoned, or invalid captures must be **promptly deleted** from our temporary processing storage once no longer needed to return the result or secure the transaction. They are not enrolled as reusable templates. Provider-side deletion follows the provider's supported processes and retention obligations. [OWNER INPUT: define “prompt” operationally for each storage location and confirm provider rejection-retention terms.]

Biometric templates are retained until account deletion unless a shorter period applies or applicable law requires a different retention period. Withdrawal of consent or deletion may mean that face login and face-based recovery can no longer be provided.

## 4. Location, routing, and runner streams

We process buyer delivery locations, seller pickup locations, muster points, and runner locations to calculate routes and coordinate runs. We use **OSRM** routing infrastructure for route and duration estimates. Production routing deployment and any external routing recipient must be confirmed before launch. [OWNER INPUT: identify the production OSRM host and confirm whether precise coordinates are sent to any third party.]

A runner's location may stream while they are assigned to or completing a run. Throttling and delivery failures can make the displayed position incomplete or delayed; it is not an emergency-tracking service or a guarantee of a runner's precise real-time position. We do not require continuous background tracking outside active run duties unless a separate, clearly disclosed feature requires it. [OWNER INPUT: confirm background-location behavior and retention periods for raw and derived location records.]

## 5. Handoff photographs, QR records, and evidence

At exchange points, the runner scans a one-time QR challenge and attaches a handoff photograph. The scan records the attempted handoff; the photograph is required to confirm it. These records may include people, premises, parcels, documents, backgrounds, location metadata, or other incidental personal data. Participants should frame photographs narrowly and avoid capturing identity documents, payment cards, bystanders, or unrelated private information.

Evidence is available only to authorized workflows and participants with a legitimate need for the relevant run or dispute. It is used for handoff confirmation, support, safety, fraud prevention, and dispute resolution—not for advertising or general biometric identification. Evidence may be retained for the applicable dispute, accounting, fraud-prevention, or legal period. [OWNER INPUT: approve evidence-retention periods and participant access rules.]

## 6. Notifications

We maintain durable in-app notification records and deliver real-time updates over an authenticated WebSocket connection when the app is connected. We use **Resend** to send transactional email, including receipts and security notices. WebSocket delivery is not guaranteed when a device is offline or disconnected; the in-app record is the durable service view.

**We do not currently send mobile push notifications through Expo Push or another push provider.** If push notifications are introduced, we will update this notice and, where required, request device permission. Marketing communication, if introduced, will require a separate choice where applicable. [OWNER INPUT: confirm whether any marketing email is currently planned and the unsubscribe/contact preference process.]

## 7. Who receives personal data

We do not sell personal data. We disclose only what is reasonably needed to relevant recipients:

- **Other participants:** for example, a buyer, seller, runner, or muster-point participant may receive the display name, run details, contact/coordination information, location, and handoff status necessary for their transaction. We limit access to relevant transactions and roles.
- **Cloudflare:** application hosting, edge compute, queues, storage, security, and related infrastructure.
- **Neon:** hosted Postgres database services for account, marketplace, settlement, and encrypted biometric records, as applicable.
- **Smile ID:** identity verification, liveness, BVN/NIN submission where enabled, provider references, and temporary selfie retrieval for our embedding workflow.
- **Flutterwave and other payment providers, if enabled:** payment collection, verification, refunds, transfers, payout-account resolution, and related fraud/compliance checks.
- **Resend:** transactional email delivery.
- **Routing, professional, regulatory, and safety recipients:** the confirmed routing host; auditors, lawyers, and advisers under confidentiality duties; and regulators, courts, law enforcement, or other parties where legally required or necessary to protect rights and safety.

Processor contracts, locations, and subprocessors must be checked before publication. [OWNER INPUT: confirm processor list, hosting regions, cross-border transfer safeguards, and any additional payment, support, analytics, or communications providers.] Some processing may occur outside Nigeria. Where required, we will use an appropriate lawful transfer mechanism and safeguards.

## 8. Retention and deletion

We keep different records only for as long as needed for the purposes described above, including account operation, dispute resolution, security, tax/accounting, fraud prevention, and legal compliance. Retention periods may therefore differ by record.

- Biometric templates are generally retained until account deletion, subject to applicable law and any approved shorter schedule.
- Rejected, failed, abandoned, or invalid captures are promptly deleted as described in section 3.
- Run, payment, settlement, refund, payout, and dispute records may need to remain after account deletion for lawful financial, fraud-prevention, or legal purposes.
- Expired operational logs, temporary files, and cached copies are removed under their applicable schedules.

When an account is deleted or a valid deletion request is completed, we initiate deletion or de-identification across our **Postgres records, Cloudflare R2 object storage, the biometric service/database, active application state, and relevant backups as they expire**, and issue deletion requests to vendors **where their interfaces and contracts support deletion**. Deletion may be delayed or limited where a record must be preserved by law, for establishment or defence of legal claims, for fraud prevention, or where an independent controller's own lawful retention applies. Backups are not necessarily edited immediately; remaining copies remain protected until scheduled expiry or restoration-handling deletion.

We will communicate material exceptions rather than promising that every copy disappears instantly. [OWNER INPUT: approve the record-by-record retention schedule, backup expiry/restoration procedure, deletion-service-level targets, and vendor deletion capabilities.]

## 9. Security

We use administrative, technical, and organizational safeguards appropriate to the risks, including role-based access controls, authenticated sessions, encryption in transit, encrypted biometric embeddings at rest, separation of identity/payment integrations, audit logging, and controlled evidence access. Operational money and evidence records are protected against arbitrary alteration; corrections use controlled, auditable processes rather than silent overwriting.

No online service, transmission, or storage system can be guaranteed completely secure. Participants should protect their devices, follow security prompts, and report suspected compromise through [OWNER INPUT: security contact and incident-reporting channel]. We will investigate and respond to incidents as required by applicable law.

## 10. Your rights and choices

Subject to applicable Nigerian data-protection law and relevant exceptions, participants may request access to, correction of, or deletion of personal data; object to or restrict certain processing; withdraw consent; request portability where applicable; and complain about our handling of personal data. Withdrawing consent does not affect earlier lawful processing. Some rights may not apply to records we must retain or where another person's rights, transaction security, or legal claims would be affected.

To make a request, contact [OWNER INPUT: privacy request email/web form] from a support channel we can associate with the participant. We may need to verify identity and authority before acting. **Do not use email alone as an account-recovery method.** We will respond within the period required by applicable law. [OWNER INPUT/LEGAL REVIEW: confirm response workflow, any authorized-agent process, and appeal/escalation wording.]

Participants may also lodge a complaint with the **Nigeria Data Protection Commission**. [OWNER INPUT/LEGAL REVIEW: insert current complaint contact/link at publication.] We would appreciate the opportunity to address concerns first, but contacting us is not a precondition to a regulatory complaint.

## 11. Eligibility and changes

[OWNER INPUT: confirm minimum participant age and whether the service excludes children; add the approved age and guardian process before publication.] We do not knowingly collect children's data outside the approved eligibility model.

We may update this notice as the service, processors, or legal requirements change. We will publish the revised date and provide additional notice where required. Material changes will not be applied retroactively without an appropriate lawful basis.

## Owner review checklist — remove before publication

- [ ] Complete every `[OWNER INPUT]` and obtain Nigerian privacy/legal review.
- [ ] Verify this notice against production code, enabled providers, actual data fields, and logs.
- [ ] Approve biometric consent, retention, rejected-capture deletion, and vendor-deletion language.
- [ ] Confirm production routing, background-location behavior, notification channels, and marketing posture.
- [ ] Approve the retention schedule, deletion propagation process, participant-rights workflow, and complaint details.
- [ ] Publish only through the approved in-app enrollment/privacy surface and record the accepted notice version.
