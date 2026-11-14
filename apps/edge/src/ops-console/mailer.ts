import type { Env } from "../config/env.js";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Keep emailed verification on the dedicated UI while Better Auth remains on edge. */
export function opsMagicLinkUrl(env: Pick<Env, "OPS_BASE_URL" | "OPS_DASHBOARD_URL">, rawUrl: string): string {
  const url = new URL(rawUrl);
  const dashboard = env.OPS_DASHBOARD_URL ?? env.OPS_BASE_URL;
  if (!dashboard) throw new Error("OPS_DASHBOARD_URL or OPS_BASE_URL is required for magic links");
  const dashboardOrigin = new URL(dashboard);
  if (dashboardOrigin.protocol !== "https:" && dashboardOrigin.hostname !== "localhost" && dashboardOrigin.hostname !== "127.0.0.1") {
    throw new Error("OPS_DASHBOARD_URL must use HTTPS outside local development");
  }
  return new URL(url.pathname + url.search, dashboardOrigin).toString();
}

export async function sendOpsMagicLinkEmail(
  env: Pick<Env, "RESEND_API_KEY" | "RESEND_FROM_EMAIL" | "OPS_BASE_URL" | "OPS_DASHBOARD_URL">,
  email: string,
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    throw new Error("RESEND_API_KEY and RESEND_FROM_EMAIL are required for ops magic links");
  }
  const url = opsMagicLinkUrl(env, rawUrl);
  const safeUrl = escapeHtml(url);
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [email],
      subject: "Your Market Runs Ops sign-in link",
      html: `<!doctype html><html><body style="margin:0;background:#f3f6f2;font-family:Arial,sans-serif;color:#18372d"><div style="max-width:560px;margin:0 auto;padding:40px 20px"><div style="background:#fbfdfb;border:1px solid #dce5de;border-radius:16px;padding:32px"><p style="font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#176345">Market Runs Operations</p><h1 style="font-size:26px;line-height:1.25">Your secure sign-in link</h1><p style="font-size:16px;line-height:1.6;color:#52665c">Use this single-use link to sign in to the operations dashboard. It expires in 10 minutes.</p><p style="margin:28px 0"><a href="${safeUrl}" style="display:inline-block;background:#176345;color:#ffffff;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:10px">Sign in to Market Runs Ops</a></p><p style="font-size:13px;line-height:1.6;color:#62736b">If you did not request this link, you can ignore this email.</p></div></div></body></html>`,
      text: `Market Runs Operations\n\nUse this single-use link to sign in within 10 minutes:\n${url}\n\nIf you did not request this link, you can ignore this email.`,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Resend could not send the ops magic link (${response.status})`);
  }
}
