import type { Metadata } from "next";
import { RegistrationForm } from "../../components/registration-form";

export const metadata: Metadata = { title: "Early access" };

export default function RegisterPage() {
  return (
    <section className="form-layout">
      <div className="form-intro">
        <span className="eyebrow">Early access</span>
        <h1>Bring your market closer.</h1>
        <p>Tell us which side of the market you are on. We will send launch updates and onboarding details when Market Runs reaches you.</p>
        <div className="form-assurance"><strong>What happens next?</strong><p>We will send a confirmation email, then contact you with relevant launch and onboarding updates.</p></div>
      </div>
      <div className="form-card"><RegistrationForm /></div>
    </section>
  );
}
