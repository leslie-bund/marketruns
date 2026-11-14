import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

const contactEmail = "info@updates.marketruns.org";
const contactHref = `mailto:${contactEmail}`;

export const metadata: Metadata = {
  title: "Privacy Notice",
  description: "How Allegados Limited handles personal data across Market Runs early access, identity, marketplace, payment, and delivery services.",
  alternates: { canonical: "https://www.marketruns.org/privacy" },
};

const sections = [
  ["about", "About this notice"],
  ["early-access", "Early access and email"],
  ["marketplace-data", "Marketplace data"],
  ["biometrics", "Face and identity"],
  ["location", "Location and maps"],
  ["evidence", "Handoff evidence"],
  ["notifications", "Notifications"],
  ["recipients", "Who receives data"],
  ["retention", "Retention and deletion"],
  ["security", "Security"],
  ["rights", "Your rights"],
  ["eligibility", "Eligibility and changes"],
] as const;

function ContactLink({ children = contactEmail }: { children?: ReactNode }) {
  return <a href={contactHref}>{children}</a>;
}

export default function PrivacyPage() {
  return (
    <article className="privacy-page">
      <header className="privacy-hero">
        <span className="eyebrow">Your data, your choices</span>
        <h1>Privacy Notice.</h1>
        <p>
          How Allegados Limited handles personal data across Market Runs early access,
          identity, marketplace, payment, and delivery services in Nigeria.
        </p>
        <dl className="privacy-meta">
          <div><dt>Effective date</dt><dd>14 November 2026</dd></div>
          <div><dt>Notice version</dt><dd><code>privacy-notice-v2</code></dd></div>
          <div><dt>Controller</dt><dd>Allegados Limited</dd></div>
          <div><dt>Privacy, security &amp; rights</dt><dd><ContactLink /></dd></div>
        </dl>
      </header>

      <div className="privacy-layout">
        <aside className="privacy-toc">
          <nav aria-label="Privacy notice sections">
            <strong>On this page</strong>
            <ol>
              {sections.map(([id, label]) => <li key={id}><a href={`#${id}`}>{label}</a></li>)}
            </ol>
          </nav>
        </aside>

        <div className="privacy-content">
          <section id="about">
            <h2>1. About this notice</h2>
            <p>
              Market Runs Nigeria (“Market Runs”, “we”, “us”) operates an errand marketplace in Nigeria.
              Buyers post requests for goods, sellers make offers, and runners collect and deliver accepted items.
              <strong> Allegados Limited is the controller</strong> for the personal data described in this notice.
            </p>
            <p>
              This notice applies when you browse our website, register for early access, verify your identity,
              trade, complete runs, contact support, or use our operations tools. It covers buyers, sellers,
              runners, store or business representatives, muster-point personnel, and operations personnel,
              according to the features they use. Separate notices may apply to employees or contractors.
            </p>
          </section>

          <section id="early-access">
            <h2>2. Early-access registration and email</h2>
            <p>
              When you register for early access, you provide your <strong>name, email address, interest</strong>{" "}
              (buyer, seller, runner, or market/delivery partner), any <strong>optional free-text message</strong>,
              and your <strong>affirmative consent to receive launch and onboarding emails</strong>. We process
              the registration identifier, confirmation-delivery status, and registration timestamp needed to
              administer the request.
            </p>
            <p>We use these details to:</p>
            <ul>
              <li>register and assess early-access interest;</li>
              <li>send the current registration-confirmation email;</li>
              <li>contact you about launch and onboarding in your area or for your selected interest; and</li>
              <li>respond to related enquiries and protect the registration service from abuse.</li>
            </ul>
            <p>
              The current emails are launch and onboarding communications, not account-recovery messages.
              You can opt out at any time by emailing <ContactLink />. <strong>There is currently no self-service
              unsubscribe workflow on the website.</strong> We handle opt-out requests through our support process;
              we may still send non-marketing service, security, or response messages where appropriate.
            </p>
          </section>

          <section id="marketplace-data">
            <h2>3. Marketplace data we collect and why</h2>
            <p>The data we handle depends on your role and actions.</p>
            <div className="privacy-table-wrap">
              <table>
                <thead><tr><th>Category</th><th>Examples</th><th>Main purposes</th></tr></thead>
                <tbody>
                  <tr><th scope="row">Account and role</th><td>Participant identifier, role, display name, account status, joined markets, device credentials, sessions, and login records</td><td>Create and secure accounts, provide role-specific features, prevent abuse, and maintain audit records</td></tr>
                  <tr><th scope="row">Verified identity</th><td>Verified legal name, verification status, BVN/NIN-derived keyed hash, provider references, and verification outcomes</td><td>Verify identity, meet applicable requirements, prevent duplicate or fraudulent accounts, and support recovery</td></tr>
                  <tr><th scope="row">Contact</th><td>Email address and support correspondence</td><td>Send early-access, service, and security messages; respond to enquiries; and resolve disputes</td></tr>
                  <tr><th scope="row">Marketplace</th><td>Intents, offers, negotiations, carts, shop items, stores, market activity, reputation signals, and seller presence</td><td>Match buyers and sellers, operate markets, coordinate checkout, and maintain marketplace integrity</td></tr>
                  <tr><th scope="row">Product and intent media</th><td>Fresh camera photos and videos of up to 15 seconds, capture references, retention deadlines, and hold/deletion records</td><td>Show what the buyer needs or seller offers, support accurate-description and non-delivery review, and investigate incidents</td></tr>
                  <tr><th scope="row">Payment and payout</th><td>Transaction references, amounts, currency, provider-returned payment-method details, hold/refund/payout status, seller payout-account details, and settlement records</td><td>Confirm holds, calculate settlement, process refunds and payouts, reconcile accounts, and investigate fraud or disputes</td></tr>
                  <tr><th scope="row">Location and run</th><td>Plus Codes, muster points, pickup and drop-off coordinates, route or floor-rate estimates, runner location, timestamps, and run status</td><td>Coordinate collection and delivery, show progress, estimate delivery charges, protect participants, and investigate incidents</td></tr>
                  <tr><th scope="row">Handoff and dispute</th><td>One-time QR challenge/scan records, handoff photographs, capture references, timestamps, dispute reasons, and supporting records</td><td>Confirm exchanges, establish chain of custody, resolve disputes, and protect against fraudulent claims</td></tr>
                  <tr><th scope="row">Biometric</th><td>Fresh face frames, one current approved enrollment selfie and private reference/hash, liveness results, one encrypted ArcFace embedding, consent/model metadata, outcomes, and provider job references</td><td>Bind a verified identity, authenticate a participant, support face-based recovery, and detect spoofing or impersonation</td></tr>
                  <tr><th scope="row">Device and operations</th><td>IP address, device/app and session information, logs, security events, notification records, operational actions, and telemetry</td><td>Deliver the website, app, and notifications; diagnose faults; secure the service; and audit operations</td></tr>
                </tbody>
              </table>
            </div>
            <p>
              We use personal data to provide and perform the participant or early-access relationship, comply
              with applicable law, protect the service and participants, and pursue legitimate interests such as
              fraud prevention and service security, balanced against individual rights. Where consent is required—
              particularly for biometric processing and optional email communications—we request it separately and prominently.
            </p>

            <h3>BVN and NIN</h3>
            <p>
              Where enabled for identity verification, you provide a Bank Verification Number (BVN) or National
              Identification Number (NIN) for submission to Smile ID. Our service creates a <strong>keyed hash</strong>
              for duplicate-account and integrity checks and does not retain the raw BVN or NIN after submission in
              the current workflow. The provider may retain submitted data under its own contract, notice, and legal
              obligations. Raw identifiers must not be written to application logs. A keyed hash remains protected personal data.
            </p>

            <h3>Display name and verified legal name</h3>
            <p>
              Your <strong>display name</strong> is used for marketplace interactions. Your <strong>verified legal
              name</strong> is limited to identity, payment, security, and dispute workflows and authorized operations
              personnel with a legitimate need. It is <strong>not visible to other participants by default</strong>.
              A display name does not replace or alter the verified legal record.
            </p>

            <h3>Email is not account recovery</h3>
            <p>
              Email alone, including a reset link, cannot recover a marketplace account or reset face/device credentials.
              Current recovery requires the participant identifier and a successful fresh face check, followed by applicable
              security controls. Do not send BVN, NIN, identity documents, or selfie images by ordinary email.
            </p>
          </section>

          <section id="biometrics">
            <h2>4. Face capture, liveness, and identity verification</h2>
            <p>
              Enrollment captures multiple fresh face frames. <strong>Smile ID</strong> performs enrollment Biometric KYC,
              liveness, and identity matching and returns a provider reference and verification result.
            </p>
            <ul>
              <li>Our private biometric service re-encodes the submitted device selfie without EXIF metadata and computes our own <strong>ArcFace embedding</strong>. Provider-returned images cannot create or replace an embedding.</li>
              <li>After vendor approval, we retain <strong>one current enrollment selfie</strong> in private Cloudflare R2 storage. It is not available through a public URL, profile, or operations view. Successful replacement deletes the previous selfie after the new enrollment commits.</li>
              <li>We store <strong>one current ArcFace embedding encrypted</strong> and associate it with one participant. Comparison is <strong>1:1</strong>, never 1:N identification or population search.</li>
              <li>Ordinary face login and current recovery use private liveness and 1:1 comparison. <strong>Login and recovery frames are transit-only</strong>: they are not retained as images or rolling templates and are not sent to Smile ID.</li>
              <li>Pending enrollment captures are <strong>promptly deleted</strong> when a job fails, is rejected, expires, is abandoned, or otherwise reaches a terminal failure. Expiry and scheduled cleanup support deletion of abandoned captures. Provider-side handling follows Smile ID’s supported processes and obligations.</li>
              <li>Liveness and similarity outcomes support access and security decisions. They reduce risk but cannot guarantee detection of every impersonation attempt.</li>
            </ul>
            <p>
              Withdrawing biometric consent or completing an approved deletion/de-identification request may mean
              that face login and face-based recovery can no longer be provided.
            </p>
          </section>

          <section id="location">
            <h2>5. Location, maps, routing, and runner streams</h2>
            <p>
              We process buyer delivery locations, seller pickup locations, muster points, and runner locations
              to coordinate runs, display maps and progress, and calculate applicable estimates.
            </p>
            <p>
              <strong>The current staging configuration does not send coordinates to an OSRM routing provider.</strong>
              OSRM is disabled in that configuration, and checkout uses static floor-rate estimates. This statement
              does not describe a future routing provider that may be separately configured and disclosed.
            </p>
            <p>
              The mobile app uses <strong>Apple Maps on iOS</strong> and <strong>Google Maps on Android</strong>
              to render run maps. These providers may process the coordinates and technical data needed to provide
              map content under their own notices.
            </p>
            <p>
              Runner GPS sharing is <strong>foreground-only</strong>. The app streams a throttled location while a
              runner is claiming or completing a run; background location is disabled. Throttling and connectivity
              failures can make a displayed position incomplete or delayed. It is not an emergency-tracking service
              or a guarantee of a precise real-time position.
            </p>
          </section>

          <section id="evidence">
            <h2>6. Handoff photographs, QR records, and evidence</h2>
            <p>
              At exchange points, the runner scans a one-time QR challenge and attaches a handoff photograph.
              The scan records the attempted handoff; the photograph is required to confirm it. These records may
              incidentally include people, premises, parcels, documents, backgrounds, or other personal data.
              Frame photographs narrowly and avoid capturing identity documents, payment cards, bystanders, or
              unrelated private information.
            </p>
            <p>
              Evidence is available only through <strong>authorized evidence-access workflows</strong> to participants
              and operations personnel with a legitimate need for the relevant run or dispute. It is used for handoff
              confirmation, support, safety, fraud prevention, and dispute resolution—not advertising or general
              biometric identification. The current enrollment selfie has no participant, profile, public, or
              operations-view read path.
            </p>
          </section>

          <section id="notifications">
            <h2>7. Notifications</h2>
            <p>
              We maintain durable in-app notification records and deliver real-time updates over an authenticated
              WebSocket connection when the app is connected. We use <strong>Resend</strong> for transactional and
              early-access email, including registration confirmation and launch/onboarding messages, and for the
              website’s inbound support workflow.
            </p>
            <p>
              WebSocket delivery is not guaranteed when a device is offline or disconnected; the in-app record is
              the durable service view. We do not currently send mobile push notifications through Expo Push or
              another push provider.
            </p>
          </section>

          <section id="recipients">
            <h2>8. Who receives personal data</h2>
            <p>We do not sell personal data. We disclose only what is reasonably needed to relevant recipients:</p>
            <ul>
              <li><strong>Other participants:</strong> display name and the run, offer, coordination, location, and handoff information necessary for their transaction. Verified legal names are not shared by default.</li>
              <li><strong>Cloudflare:</strong> application and edge hosting, compute, queues, private object storage, security, and related infrastructure.</li>
              <li><strong>Neon:</strong> hosted Postgres database services for site, account, marketplace, settlement, and encrypted biometric records, as applicable.</li>
              <li><strong>Smile ID:</strong> enrollment Biometric KYC, liveness and identity binding, BVN/NIN submission where enabled, and provider references. Ordinary login and current recovery captures are not sent to Smile ID.</li>
              <li><strong>Flutterwave:</strong> payment collection and verification, refunds, transfers, payout-account resolution, and related fraud/compliance checks. Payment providers process card or bank credentials under their own notices; our settlement records do not need full card numbers.</li>
              <li><strong>Resend:</strong> early-access Audience/contact administration, confirmation and launch/onboarding email, service email, and inbound support email.</li>
              <li><strong>Vercel:</strong> public website hosting and delivery.</li>
              <li><strong>Render:</strong> hosting for the private biometric service.</li>
              <li><strong>Google Maps and Apple Maps:</strong> mobile map rendering on Android and iOS respectively.</li>
              <li><strong>Professional, regulatory, and safety recipients:</strong> advisers under confidentiality duties and public authorities or other parties where legally required or necessary to protect rights and safety.</li>
            </ul>
            <p>
              Some processing may occur outside Nigeria. Where required, we use an appropriate lawful transfer
              mechanism and safeguards. This notice does not assert vendor-specific processing regions that have
              not been confirmed.
            </p>
          </section>

          <section id="retention">
            <h2>9. Retention, deletion, and de-identification</h2>
            <p>
              We keep different records only for as long as reasonably needed for the purposes described above.
              Criteria include the life and status of an account or registration, completion and dispute status
              of a run, security and fraud-prevention needs, record sensitivity, tax/accounting requirements,
              legal claims, and other applicable legal obligations.
            </p>
            <ul>
              <li>The current ArcFace embedding and one approved enrollment selfie are kept for ongoing face authentication and replaced through successful re-enrollment, subject to an approved deletion/de-identification request and applicable exceptions.</li>
              <li>Login and recovery captures are transit-only. Pending enrollment captures are deleted promptly on failure, rejection, expiry, abandonment, or another terminal failure.</li>
              <li>Product and intent media remain private. Expired intents and unaccepted products are deleted after seven days. Sold-product media is deleted 90 days after run close, with a 97-day backstop if no close event has arrived. A documented incident/legal hold can pause deletion of a specific item; releasing it restores the existing deadline. Scheduled cleanup deletes the bytes, and media metadata remains.</li>
              <li>Run, payment, settlement, refund, payout, and dispute records may need to remain after an account request for lawful financial, fraud-prevention, dispute, or legal purposes.</li>
              <li>Operational logs, temporary files, and cached copies are removed under schedules appropriate to their purpose and sensitivity.</li>
            </ul>
            <div className="privacy-callout">
              <h3>Manual account deletion requests</h3>
              <p>
                <strong>Account deletion/de-identification is currently a manual request and process, not a completed
                self-service deletion feature.</strong> To request it, email <ContactLink />. We may need to verify
                your identity and authority. Authorized personnel will review the request and coordinate deletion
                or de-identification across relevant application records, identity artifacts, and active state where
                feasible and legally permitted.
              </p>
            </div>
            <p>
              We <strong>do not promise immediate erasure from every vendor or backup</strong>. Vendor deletion
              depends on supported interfaces, contracts, independent legal obligations, and retention schedules.
              Backups are not necessarily edited immediately; remaining copies remain protected until scheduled
              expiry or appropriate restoration handling. Some records may be retained or de-identified rather than
              erased where required for law, legal claims, fraud prevention, another person’s rights, or transaction
              integrity. We will communicate material exceptions through the request process.
            </p>
          </section>

          <section id="security">
            <h2>10. Security</h2>
            <p>
              We use administrative, technical, and organizational safeguards appropriate to the risks, including
              role-based access controls, authenticated sessions, encryption in transit, encrypted ArcFace embeddings
              at rest, private capture storage, separation of identity/payment integrations, audit logging, and
              controlled evidence access. Operational money and evidence records use controlled, auditable processes
              rather than arbitrary alteration.
            </p>
            <p>
              No online service, transmission, or storage system can be guaranteed completely secure. Protect your
              devices, follow security prompts, and report suspected compromise or a privacy/security concern to{" "}
              <ContactLink />. We investigate and respond to incidents as required by applicable law.
            </p>
          </section>

          <section id="rights">
            <h2>11. Your rights and choices</h2>
            <p>
              Subject to applicable Nigerian data-protection law and relevant exceptions, you may request access to,
              correction of, or deletion of personal data; object to or restrict certain processing; withdraw consent;
              request portability where applicable; and complain about our handling of personal data. Withdrawing
              consent does not affect earlier lawful processing. Some rights may not apply where records must be
              retained, another person’s rights are affected, or transaction security or legal claims are involved.
            </p>
            <p>
              To make a privacy or rights request, email <ContactLink />. We may need to verify your identity and
              authority before acting. This channel handles requests manually; it is not an account-recovery method.
              We will respond within the period required by applicable law.
            </p>
            <p>
              You may also lodge a complaint with the <strong>Nigeria Data Protection Commission</strong> through its
              <a href="https://ndpc.gov.ng/contact/" target="_blank" rel="noreferrer"> official contact and complaint channels</a>.
              We would appreciate the opportunity to address your concern first, but contacting us is not a precondition
              to a regulatory complaint.
            </p>
          </section>

          <section id="eligibility">
            <h2>12. Eligibility and changes</h2>
            <p>
              Market Runs is intended only for people aged <strong>18 or older</strong>. Do not register for early
              access or use participant services if you are under 18. We do not knowingly collect children’s data.
              If you believe a child has provided personal data, contact us so we can review and take appropriate action.
            </p>
            <p>
              We may update this notice as the service, processors, or legal requirements change. We will publish
              the revised effective date and version and provide additional notice where required. Material changes
              will not be applied retroactively without an appropriate lawful basis.
            </p>
          </section>

          <div className="privacy-end">
            <p>Questions about this notice or your data?</p>
            <a className="button" href={contactHref}>Contact privacy support</a>
            <Link className="button secondary" href="/register">Early-access registration</Link>
          </div>
        </div>
      </div>
    </article>
  );
}
