import type { Metadata } from "next";
import { listLeadRegistrations } from "../../../src/db";
import { requireAdmin } from "../../../src/server";
import { formatDate, PortalShell } from "../inbox/portal";
import styles from "../inbox/inbox.module.css";

export const metadata: Metadata = { title: "Registrations" };
export const dynamic = "force-dynamic";

export default async function LeadRegistrationsPage() {
  const { site, user } = await requireAdmin();
  const leads = await listLeadRegistrations(site);

  return (
    <PortalShell email={user.email}>
      <section className={styles.content}>
        <div className={styles.headingRow}><div><p className={styles.eyebrow}>Early access</p><h1>Visitor registrations</h1><p className={styles.description}>People who asked for Market Runs launch and onboarding updates.</p></div><span className={styles.count}>{leads.length} total</span></div>
        {leads.length === 0 ? (
          <div className={styles.empty}><h2>No registrations yet</h2><p>New visitor registrations will appear here.</p></div>
        ) : (
          <ul className={styles.inboxList}>
            {leads.map((lead) => (
              <li key={lead.id}><div className={styles.emailRow}>
                <strong className={styles.sender}>{lead.name}</strong>
                <div><a className={styles.subject} href={`mailto:${lead.email}`}>{lead.email}</a>{lead.message ? <p className={styles.recipient}>{lead.message}</p> : null}</div>
                <div><span className={styles.recipient}>{lead.interest}</span><p className={`${styles.badge} ${lead.confirmation_sent === "sent" ? styles.sent : styles.failed}`}>Confirmation {lead.confirmation_sent}</p></div>
                <time className={styles.date} dateTime={lead.created_at}>{formatDate(lead.created_at)}</time>
              </div></li>
            ))}
          </ul>
        )}
      </section>
    </PortalShell>
  );
}
