import Link from "next/link";
import type { ReactNode } from "react";
import { SignOutButton } from "../../../components/sign-out-button";
import styles from "./inbox.module.css";

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Lagos",
  timeZoneName: "short",
});

export function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value || "Date unavailable" : dateFormatter.format(date);
}

export function receivedAddresses(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      const addresses = parsed.filter((address): address is string => typeof address === "string" && address.length > 0);
      return addresses.length > 0 ? addresses.join(", ") : "Not specified";
    }
  } catch {
    return "Not specified";
  }
  return "Not specified";
}

export function PortalShell({ email, children }: Readonly<{ email: string; children: ReactNode }>) {
  return (
    <div className={styles.portal}>
      <header className={styles.header}>
        <div className={styles.brandRow}>
          <Link className={styles.brand} href="/admin/inbox" aria-label="Market Runs admin inbox">
            market<span className={styles.brandDot}>·</span>runs
            <span className={styles.portalTag}>Admin</span>
          </Link>
          <div className={styles.account}>
            <span className={styles.accountEmail} title={email}>{email}</span>
            <SignOutButton className={styles.signOut} />
          </div>
        </div>
        <nav className={styles.nav} aria-label="Admin portal">
          <Link className={`${styles.navLink} ${styles.active}`} href="/admin/inbox" aria-current="page">
            Inbox
          </Link>
          <Link className={styles.navLink} href="/admin/leads">
            Registrations
          </Link>
        </nav>
      </header>
      {children}
      <footer className={styles.portalFooter}>
        <span>Private admin workspace</span>
        <span>Market Runs</span>
      </footer>
    </div>
  );
}
