import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Market Runs · Your market, one run", template: "%s · Market Runs" },
  description:
    "Post what you need from local markets, receive offers from sellers, and let one runner bring the whole cart in a single trip.",
};

const contactEmail = process.env.INBOUND_EMAIL_ADDRESS ?? "hello@market-runs.example";

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="site-shell">
          <header className="topbar">
            <Link className="brand" href="/" aria-label="Market Runs home">
              market<span>·</span>runs
            </Link>
            <nav className="nav" aria-label="Main navigation">
              <Link href="/#how-it-works">How it works</Link>
              <Link href="/register">Early access</Link>
              <Link className="nav-admin" href="/admin/inbox">Admin portal</Link>
            </nav>
          </header>
          <main>{children}</main>
          <footer className="footer">
            <div>
              <span className="footer-brand">market·runs</span>
              <p>One intent. One cart. One run.</p>
            </div>
            <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
          </footer>
        </div>
      </body>
    </html>
  );
}
