"use client";

import { useState, type FormEvent } from "react";

export function RegistrationForm() {
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setStatus("submitting");
    setMessage("");
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const response = await fetch("/api/registrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await response.json() as { confirmationSent?: boolean; message?: string };
      if (!response.ok) {
        setStatus("error");
        setMessage(result.message ?? "Please check your details and try again.");
        return;
      }
      form.reset();
      setStatus("success");
      setMessage(result.confirmationSent
        ? "Registration received. Your confirmation email is on its way."
        : "Registration received. We will be in touch with launch updates.");
    } catch {
      setStatus("error");
      setMessage("We could not send your registration. Please try again.");
    }
  }

  return (
    <form className="stack-form" onSubmit={submit}>
      <label>Full name<input name="name" autoComplete="name" minLength={2} maxLength={100} required placeholder="Your name" /></label>
      <label>Email address<input name="email" type="email" autoComplete="email" required placeholder="you@example.com" /></label>
      <label>I am interested as a
        <select name="interest" defaultValue="buyer" required>
          <option value="buyer">Buyer</option><option value="seller">Seller</option>
          <option value="runner">Runner</option><option value="partner">Market or delivery partner</option>
        </select>
      </label>
      <label>Anything we should know?<textarea name="message" rows={4} maxLength={2000} placeholder="Your market, location, or what you would like Market Runs to help with" /></label>
      <label className="consent-field"><input name="consent" type="checkbox" value="true" required /><span>I agree to receive Market Runs launch and onboarding emails. I can unsubscribe at any time.</span></label>
      <button className="button" type="submit" disabled={status === "submitting"}>{status === "submitting" ? "Registering…" : "Register my interest"}</button>
      <p className={status === "error" ? "form-message error" : "form-message success"} role="status">{message}</p>
    </form>
  );
}
