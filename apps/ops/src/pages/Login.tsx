import { useState, type FormEvent } from "react";
import { ArrowRight, KeyRound, Mail, ShieldCheck } from "lucide-react";
import { changePassword, getSession, sendMagicLink, signIn, type OpsUser } from "../lib/ops-api";
import BrandMark from "../components/BrandMark";

interface LoginProps {
  onAuthenticated: (user: OpsUser) => void;
  initialPasswordChange?: boolean;
}

export default function Login({ onAuthenticated, initialPasswordChange = false }: LoginProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(initialPasswordChange);
  const [busy, setBusy] = useState(false);
  const [magicBusy, setMagicBusy] = useState(false);
  const [magicSent, setMagicSent] = useState(false);
  const [error, setError] = useState("");

  const submitLogin = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMagicSent(false);
    try {
      await signIn(email.trim(), password);
      const user = await getSession();
      if (!user) throw new Error("The session could not be established. Try again.");
      if (user.mustChangePassword) setChangingPassword(true);
      else onAuthenticated(user);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  const submitMagicLink = async () => {
    const normalizedEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setError("Enter your admin email address first.");
      return;
    }
    setMagicBusy(true);
    setError("");
    setMagicSent(false);
    try {
      await sendMagicLink(normalizedEmail);
      setMagicSent(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send a sign-in link. Try again.");
    } finally {
      setMagicBusy(false);
    }
  };

  const submitPasswordChange = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await changePassword(password, newPassword);
      const user = await getSession();
      if (!user) throw new Error("The session could not be refreshed. Sign in again.");
      onAuthenticated({ ...user, mustChangePassword: false });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Password change failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-shell">
      <section className="login-brand" aria-label="Market Runs operations">
        <BrandMark />
        <div className="login-brand-copy">
          <p className="overline">Market Runs · Operations</p>
          <h1>Keep every market moving.</h1>
          <p>One secure workspace for market oversight, participant operations, and settlement review.</p>
        </div>
        <div className="login-trust"><ShieldCheck size={18} /><span>Staff access only · Better Auth protected</span></div>
      </section>

      <section className="login-form-wrap">
        <div className="login-form-heading">
          <span className="icon-badge"><KeyRound size={20} /></span>
          <div>
            <h2>{changingPassword ? "Secure your account" : "Welcome back"}</h2>
            <p>{changingPassword ? "Replace the bootstrap password before continuing." : "Sign in with your operator account."}</p>
          </div>
        </div>

        {changingPassword ? (
          <form onSubmit={submitPasswordChange} className="login-form">
            <label htmlFor="password">Current password</label>
            <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Your current password" />
            <label htmlFor="new-password">New password</label>
            <input id="new-password" type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="At least 12 characters" />
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary-button" disabled={busy} type="submit">
              {busy ? "Updating…" : "Change password and continue"}<ArrowRight size={17} />
            </button>
          </form>
        ) : (
          <form onSubmit={submitLogin} className="login-form">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="username" required value={email} onChange={(event) => { setEmail(event.target.value); setMagicSent(false); }} placeholder="you@marketruns.org" />
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Your password" />
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary-button" disabled={busy || magicBusy} type="submit">
              {busy ? "Signing in…" : "Sign in with password"}<ArrowRight size={17} />
            </button>
            <div className="auth-divider"><span>or</span></div>
            <button className="secondary-button magic-link-button" disabled={busy || magicBusy} type="button" onClick={() => void submitMagicLink()}>
              <Mail size={17} />{magicBusy ? "Sending link…" : magicSent ? "Resend sign-in link" : "Email me a sign-in link"}
            </button>
            {magicSent && <p className="magic-link-status" role="status">If an admin account matches that address, a single-use link is on its way. It expires in 10 minutes.</p>}
          </form>
        )}
        <p className="login-footnote">Magic links are available only to existing ops admins. Participant accounts and biometric sign-in stay separate.</p>
      </section>
    </main>
  );
}
