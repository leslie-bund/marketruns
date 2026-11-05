"use client";

import { useState } from "react";
import { authClient } from "../src/auth-client";

export function SignOutButton({ className = "text-button" }: Readonly<{ className?: string | undefined }>) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setPending(true);
    setFailed(false);
    try {
      const { error } = await authClient.signOut();
      if (error) throw new Error("Sign out failed");
      window.location.assign("/");
    } catch {
      setPending(false);
      setFailed(true);
    }
  }

  return (
    <button className={className} type="button" disabled={pending} onClick={signOut}>
      {pending ? "Signing out…" : failed ? "Try sign out again" : "Sign out"}
    </button>
  );
}
