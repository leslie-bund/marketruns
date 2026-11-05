"use client";

import { useState } from "react";

export function SignOutButton({ className = "text-button" }: Readonly<{ className?: string | undefined }>) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("Sign out failed");
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
