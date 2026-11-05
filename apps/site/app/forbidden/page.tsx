import Link from "next/link";

export default function ForbiddenPage() {
  return <section className="auth-layout"><div className="form-card auth-card"><span className="eyebrow">Access denied</span><h1>This account is not an admin.</h1><p>The shared inbox and visitor registrations are restricted to configured admin addresses.</p><Link className="button secondary" href="/">Back to the site</Link></div></section>;
}
