import type { Metadata } from "next";
import Link from "next/link";
import { listInboundEmails } from "../../../src/db";
import { requireAdmin } from "../../../src/server";
import styles from "./inbox.module.css";
import { formatDate, PortalShell, receivedAddresses } from "./portal";

export const metadata: Metadata = { title: "Admin inbox" };
export const dynamic = "force-dynamic";

export default async function AdminInboxPage() {
  const { site, user } = await requireAdmin();
  const emails = await listInboundEmails(site);

  return (
    <PortalShell email={user.email}>
      <section className={styles.content} aria-labelledby="inbox-title">
        <div className={styles.headingRow}>
          <div>
            <p className={styles.eyebrow}>Shared inbox</p>
            <h1 id="inbox-title">Conversations that matter.</h1>
            <p className={styles.description}>
              Read incoming mail and keep every Market Runs reply in one place.
            </p>
          </div>
          <span className={styles.count}>{emails.length} {emails.length === 1 ? "message" : "messages"}</span>
        </div>

        {emails.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyMark} aria-hidden="true">@</span>
            <h2>Your inbox is ready</h2>
            <p>Messages sent to your Market Runs inbox will appear here, newest first.</p>
            <Link className={styles.emptyLink} href="/admin/leads">View visitor registrations</Link>
          </div>
        ) : (
          <ul className={styles.inboxList}>
            {emails.map((email) => {
              const subject = email.subject.trim() || "(No subject)";
              return (
                <li key={email.id}>
                  <Link
                    className={styles.emailRow}
                    href={`/admin/inbox/${encodeURIComponent(email.id)}`}
                    aria-label={`Open email from ${email.from_address}: ${subject}`}
                  >
                    <span className={styles.sender}>{email.from_address || "Unknown sender"}</span>
                    <span className={styles.subject}>{subject}</span>
                    <span className={styles.recipient}>To {receivedAddresses(email.to_addresses)}</span>
                    <time className={styles.date} dateTime={email.received_at}>
                      {formatDate(email.received_at)}
                    </time>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </PortalShell>
  );
}
