import Link from "next/link";

export default function NotFound() {
  return <section className="auth-layout"><div className="form-card auth-card"><span className="eyebrow">404</span><h1>That page could not be found.</h1><p>The link may be old, or the conversation may no longer be available.</p><Link className="button" href="/">Return home</Link></div></section>;
}
