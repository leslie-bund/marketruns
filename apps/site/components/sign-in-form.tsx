"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "../src/auth-client";

export function SignInForm() {
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    try {
      const { error } = await authClient.signIn.magicLink({ email, callbackURL: "/admin/inbox" });
      setSent(!error);
      setMessage(!error
        ? "If that address is an admin, a sign-in link is on its way. Check your inbox."
        : "We could not start sign-in. Please try again.");
    } catch {
      setSent(false);
      setMessage("We could not start sign-in. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="stack-form" onSubmit={submit}>
      <label>Admin email<input name="email" type="email" autoComplete="email" required /></label>
      <button className="button" type="submit" disabled={pending}>{pending ? "Sending…" : "Email me a sign-in link"}</button>
      <p className={sent ? "form-message success" : "form-message error"} role="status">{message}</p>
    </form>
  );
}
