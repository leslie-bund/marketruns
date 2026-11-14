# Market Runs Nigeria Privacy Notice

- **Effective date:** 14 November 2026
- **Notice version:** `privacy-notice-v2`
- **Controller:** Allegados Limited
- **Privacy, security, and rights contact:** [info@updates.marketruns.org](mailto:info@updates.marketruns.org)
- **Published at:** [https://www.marketruns.org/privacy](https://www.marketruns.org/privacy)

## 1. About this notice

Market Runs Nigeria (“Market Runs”, “we”, “us”) operates an errand marketplace in Nigeria. Buyers post requests for goods, sellers make offers, and runners collect and deliver accepted items. Allegados Limited is the controller for the personal data described in this notice.

This notice explains how we handle personal data when people browse our website, register for early access, verify their identity, trade, complete runs, contact support, or use our operations tools. It applies to buyers, sellers, runners, store or business representatives, muster-point personnel, and operations personnel, according to the features they use. Separate notices may apply to employees or contractors.

## 2. Early-access registration and email

When you register for early access, you provide your **name, email address, interest** (buyer, seller, runner, or market/delivery partner), any **optional free-text message**, and your **affirmative consent to receive launch and onboarding emails**. We process the registration identifier, confirmation-delivery status, and registration timestamp needed to administer the request.

We use these details to:

- register and assess early-access interest;
- send the current registration-confirmation email;
- contact you about Market Runs launch and onboarding in your area or for your selected interest; and
- respond to related enquiries and protect the registration service from abuse.

The current emails are launch and onboarding communications, not account-recovery messages. You can opt out of these emails at any time by emailing [info@updates.marketruns.org](mailto:info@updates.marketruns.org). **There is currently no self-service unsubscribe workflow on the website.** We will handle an opt-out request through our support process; we may still send non-marketing service, security, or response messages where appropriate.

## 3. Marketplace data we collect and why

The data we handle depends on your role and actions.

| Category | Examples | Main purposes |
| --- | --- | --- |
| Account and role data | Participant identifier, role, display name, account status, joined markets, device credentials, sessions, and login records | Create and secure accounts, provide role-specific features, prevent abuse, and maintain audit records |
| Verified identity data | Verified legal name, verification status, BVN/NIN-derived keyed hash, provider references, and verification outcomes | Verify identity, meet applicable requirements, prevent duplicate or fraudulent accounts, and support recovery |
| Contact data | Email address and support correspondence | Send early-access, service, and security messages; respond to enquiries; and resolve disputes |
| Marketplace data | Intents, offers, negotiations, carts, shop items, stores, market activity, reputation signals, and seller presence | Match buyers and sellers, operate markets, coordinate checkout, and maintain marketplace integrity |
| Product and intent media | Fresh camera photos and videos of up to 15 seconds, capture references, retention deadlines, and hold/deletion records | Show what the buyer needs or seller offers, support accurate-description and non-delivery review, and investigate incidents |
| Payment and payout data | Charge and transaction references, amounts, currency, payment-method details returned by the provider, hold/refund/payout status, seller payout-account details, and settlement records | Confirm holds, calculate settlement, execute or record refunds and payouts, reconcile accounts, and investigate fraud or disputes |
| Location and run data | Plus Codes, muster points, pickup and drop-off coordinates, route or floor-rate estimates, runner location, timestamps, and run status | Coordinate collection and delivery, show run progress, estimate delivery charges, protect participants, and investigate incidents |
| Handoff and dispute evidence | One-time QR challenge/scan records, handoff photographs, capture references, scan/confirmation timestamps, dispute reasons, and supporting records | Confirm exchanges, establish chain of custody, resolve disputes, and protect against fraudulent claims |
| Biometric data | Fresh face-capture frames, one current approved enrollment selfie and private object reference/content hash, liveness results, one encrypted ArcFace embedding, consent/model metadata, comparison outcomes, and provider job references | Bind a verified identity to an account, authenticate a participant, support face-based recovery, and detect spoofing or impersonation |
| Device, technical, and operations data | IP address, device/app and session information, logs, security events, notification records, operational actions, and service telemetry | Deliver the website, app, and notifications; diagnose faults; secure the service; and audit operations activity |

We use personal data to provide and perform the participant or early-access relationship, comply with applicable law, protect the service and participants, and pursue legitimate interests such as fraud prevention and service security, balanced against individual rights. Where consent is required—particularly for biometric processing and optional email communications—we request it separately and prominently.

### BVN and NIN

Where enabled for identity verification, you provide a Bank Verification Number (BVN) or National Identification Number (NIN) for submission to Smile ID. Our service creates a **keyed hash** for duplicate-account and integrity checks and does not retain the raw BVN or NIN after submission in the current workflow. The provider may retain submitted data under its own contract, notice, and legal obligations. Raw identifiers must not be written to application logs. A keyed hash remains protected personal data.

### Display name and verified legal name

Your **display name** is used for marketplace interactions. Your **verified legal name** is limited to identity, payment, security, and dispute workflows and authorized operations personnel with a legitimate need. It is **not visible to other participants by default**. A display name does not replace or alter the verified legal record.

### Email is not account recovery

Email is used for early-access, service, security, and support communications. **Email alone, including a reset link, cannot recover a marketplace account or reset face/device credentials.** Current account recovery requires the participant identifier and a successful fresh face check, followed by the applicable security controls. Do not send BVN, NIN, identity documents, or selfie images by ordinary email.

## 4. Face capture, liveness, and identity verification

Enrollment captures multiple fresh face frames. **Smile ID** performs enrollment Biometric KYC, liveness, and identity matching and returns a provider reference and verification result.

- Our private biometric service re-encodes the submitted device selfie without EXIF metadata and computes our own **ArcFace embedding** from that selfie. Provider-returned images cannot create or replace an embedding.
- After vendor approval, we retain **one current enrollment selfie** in private Cloudflare R2 storage, associated with the participant, content hash, capture consent, and model version. It is not available through a public URL, profile, or operations view. Successful replacement deletes the previous selfie after the new enrollment commits.
- We store **one current ArcFace embedding encrypted** in our biometric database and associate it with one participant. Comparison is **1:1**: a fresh capture is compared with that participant’s enrolled template. We do not use it for 1:N identification or population search.
- Ordinary face login and current face-based recovery use our private liveness and 1:1 comparison. **Login and recovery frames are transit-only**: they are not retained as images or rolling templates and are not sent to Smile ID.
- Pending enrollment captures are **promptly deleted** when a job fails, is rejected, expires, is abandoned, or otherwise reaches a terminal failure. Expiry and scheduled cleanup support deletion of abandoned pending captures. Provider-side handling follows Smile ID’s supported processes and retention obligations.
- Liveness and similarity outcomes support access and security decisions. They reduce risk but cannot guarantee detection of every impersonation attempt.

Withdrawing biometric consent or completing an approved deletion/de-identification request may mean that face login and face-based recovery can no longer be provided.

## 5. Location, maps, routing, and runner streams

We process buyer delivery locations, seller pickup locations, muster points, and runner locations to coordinate runs, display maps and progress, and calculate applicable estimates.

**The current staging configuration does not send coordinates to an OSRM routing provider.** OSRM is disabled in that configuration, and checkout uses static floor-rate estimates. This statement does not describe a future routing provider that may be separately configured and disclosed.

The mobile app uses **Apple Maps on iOS** and **Google Maps on Android** to render run maps. These providers may process the coordinates and technical data needed to provide map content under their own notices.

Runner GPS sharing is **foreground-only**. The app requests foreground location permission and streams a throttled location while a runner is claiming or completing a run; background location is disabled. Throttling and connectivity failures can make a displayed position incomplete or delayed. It is not an emergency-tracking service or a guarantee of a precise real-time position.

## 6. Handoff photographs, QR records, and evidence

At exchange points, the runner scans a one-time QR challenge and attaches a handoff photograph. The scan records the attempted handoff; the photograph is required to confirm it. These records may incidentally include people, premises, parcels, documents, backgrounds, or other personal data. Frame photographs narrowly and avoid capturing identity documents, payment cards, bystanders, or unrelated private information.

Evidence is available only through **authorized evidence-access workflows** to participants and operations personnel with a legitimate need for the relevant run or dispute. It is used for handoff confirmation, support, safety, fraud prevention, and dispute resolution—not advertising or general biometric identification. Access to enrollment selfies is more restricted: the current enrollment selfie has no participant, profile, public, or operations-view read path.

## 7. Notifications

We maintain durable in-app notification records and deliver real-time updates over an authenticated WebSocket connection when the app is connected. We use **Resend** for transactional and early-access email, including registration confirmation and launch/onboarding messages, and for the website’s inbound support workflow.

WebSocket delivery is not guaranteed when a device is offline or disconnected; the in-app record is the durable service view. We do not currently send mobile push notifications through Expo Push or another push provider.

## 8. Who receives personal data

We do not sell personal data. We disclose only what is reasonably needed to relevant recipients:

- **Other participants:** display name and the run, offer, coordination, location, and handoff information necessary for their transaction. Verified legal names are not shared with other participants by default.
- **Cloudflare:** application and edge hosting, compute, queues, private object storage, security, and related infrastructure.
- **Neon:** hosted Postgres database services for site, account, marketplace, settlement, and encrypted biometric records, as applicable.
- **Smile ID:** enrollment Biometric KYC, enrollment liveness and identity binding, BVN/NIN submission where enabled, and provider references. Ordinary login and current recovery captures are not sent to Smile ID.
- **Flutterwave:** payment collection and verification, refunds, transfers, payout-account resolution, and related fraud/compliance checks. Payment providers process card or bank credentials under their own notices; our settlement records do not need full card numbers.
- **Resend:** early-access Audience/contact administration, confirmation and launch/onboarding email, service email, and inbound support email.
- **Vercel:** public website hosting and delivery.
- **Render:** hosting for the private biometric service.
- **Google Maps and Apple Maps:** mobile map rendering on Android and iOS respectively.
- **Professional, regulatory, and safety recipients:** auditors, lawyers, and advisers under confidentiality duties; and regulators, courts, law enforcement, or other parties where legally required or necessary to protect rights and safety.

Some processing may occur outside Nigeria. Where required, we use an appropriate lawful transfer mechanism and safeguards. This notice does not assert vendor-specific processing regions that have not been confirmed.

## 9. Retention, deletion, and de-identification

We keep different records only for as long as reasonably needed for the purposes described above. Criteria include the life and status of an account or registration, completion and dispute status of a run, security and fraud-prevention needs, the sensitivity of the record, tax/accounting requirements, legal claims, and other applicable legal obligations.

- The current ArcFace embedding and one current approved enrollment selfie are kept for ongoing face authentication and replaced through successful re-enrollment, subject to an approved deletion/de-identification request and applicable exceptions.
- Login and recovery captures are transit-only. Pending enrollment captures are deleted promptly on failure, rejection, expiry, abandonment, or another terminal failure.
- Product and intent media remain private. Expired intents and unaccepted products are deleted after seven days. Sold-product media is deleted 90 days after run close, with a 97-day backstop if the close event has not arrived. A documented incident/legal hold can pause deletion of a specific item; releasing it restores the existing deadline. Scheduled cleanup performs deletion, and media metadata remains after byte deletion.
- Run, payment, settlement, refund, payout, and dispute records may need to remain after an account request for lawful financial, fraud-prevention, dispute, or legal purposes.
- Operational logs, temporary files, and cached copies are removed under schedules appropriate to their purpose and sensitivity.

**Account deletion/de-identification is currently a manual request and process, not a completed self-service deletion feature.** To request it, email [info@updates.marketruns.org](mailto:info@updates.marketruns.org). We may need to verify your identity and authority. Authorized personnel will review the request and coordinate deletion or de-identification across relevant application records, identity artifacts, and active state where feasible and legally permitted.

We **do not promise immediate erasure from every vendor or backup**. Vendor deletion depends on supported interfaces, contracts, independent legal obligations, and retention schedules. Backups are not necessarily edited immediately; remaining copies remain protected until scheduled expiry or appropriate restoration handling. Some records may be retained or de-identified rather than erased where required for law, legal claims, fraud prevention, another person’s rights, or transaction integrity. We will communicate material exceptions through the request process.

## 10. Security

We use administrative, technical, and organizational safeguards appropriate to the risks, including role-based access controls, authenticated sessions, encryption in transit, encrypted ArcFace embeddings at rest, private capture storage, separation of identity/payment integrations, audit logging, and controlled evidence access. Operational money and evidence records use controlled, auditable processes rather than arbitrary alteration.

No online service, transmission, or storage system can be guaranteed completely secure. Protect your devices, follow security prompts, and report suspected compromise or a privacy/security concern to [info@updates.marketruns.org](mailto:info@updates.marketruns.org). We investigate and respond to incidents as required by applicable law.

## 11. Your rights and choices

Subject to applicable Nigerian data-protection law and relevant exceptions, you may request access to, correction of, or deletion of personal data; object to or restrict certain processing; withdraw consent; request portability where applicable; and complain about our handling of personal data. Withdrawing consent does not affect earlier lawful processing. Some rights may not apply where records must be retained, another person’s rights are affected, or transaction security or legal claims are involved.

To make a privacy or rights request, email [info@updates.marketruns.org](mailto:info@updates.marketruns.org). We may need to verify your identity and authority before acting. This email channel handles requests manually; it is not an account-recovery method. We will respond within the period required by applicable law.

You may also lodge a complaint with the **Nigeria Data Protection Commission** through its [official contact and complaint channels](https://ndpc.gov.ng/contact/). We would appreciate the opportunity to address your concern first, but contacting us is not a precondition to a regulatory complaint.

## 12. Eligibility and changes

Market Runs is intended only for people aged **18 or older**. Do not register for early access or use participant services if you are under 18. We do not knowingly collect children’s data. If you believe a child has provided personal data, contact us so we can review and take appropriate action.

We may update this notice as the service, processors, or legal requirements change. We will publish the revised effective date and version and provide additional notice where required. Material changes will not be applied retroactively without an appropriate lawful basis.
