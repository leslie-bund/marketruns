import { escapeHtml } from "./pages.js";
import type { SiteEnv } from "./env.js";

/** Sends transactional mail through the Resend API. Returns false when mail is not configured. */
export async function sendEmail(
  env: SiteEnv,
  message: { to: string; subject: string; html: string },
): Promise<boolean> {
  if (!env.resendApiKey || !env.resendFromEmail) {
    console.warn("[site] mail not sent — RESEND_API_KEY / RESEND_FROM_EMAIL unset (to:", message.to + ")");
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.resendApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.resendFromEmail, to: [message.to], subject: message.subject, html: message.html }),
  });
  if (!res.ok) {
    console.warn("[site] resend send failed:", res.status, await res.text().catch(() => ""));
    return false;
  }
  return true;
}

export async function sendMagicLinkEmail(env: SiteEnv, email: string, url: string): Promise<boolean> {
  return sendEmail(env, {
    to: email,
    subject: "Your Market Runs sign-in link",
    html: `
      <div style="font-family:ui-sans-serif,system-ui,sans-serif;background:#0b0f0c;color:#e8f0e9;padding:2rem">
        <h2 style="margin:0 0 1rem">market<span style="color:#4ade80">·</span>runs</h2>
        <p>Here is your sign-in link — it expires shortly and works once:</p>
        <p><a href="${escapeHtml(url)}" style="background:#4ade80;color:#07130b;padding:0.7rem 1.2rem;border-radius:10px;text-decoration:none;font-weight:700;display:inline-block">Sign in to Market Runs</a></p>
        <p style="color:#a7b8ab;font-size:0.85rem">If you did not request this link, you can ignore this email.</p>
      </div>`,
  });
}
