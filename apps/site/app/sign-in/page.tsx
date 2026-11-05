import type { Metadata } from "next";
import { SignInForm } from "../../components/sign-in-form";

export const metadata: Metadata = { title: "Admin sign in" };

export default function SignInPage() {
  return (
    <section className="auth-layout">
      <div className="form-card auth-card">
        <span className="eyebrow">Restricted access</span>
        <h1>Admin sign in</h1>
        <p>Enter your approved admin email. We will send you a secure, one-time sign-in link.</p>
        <SignInForm />
      </div>
    </section>
  );
}
