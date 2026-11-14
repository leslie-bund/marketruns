import { createElement } from "react";
import { render } from "react-email";
import type { Attachment } from "resend";
import MagicLinkEmail from "../emails/magic-link";
import type { SiteEnv } from "./env";
import { createResendClient } from "./resend";

interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: Attachment[];
  idempotencyKey?: string;
}

export async function sendEmail(env: SiteEnv, message: EmailMessage): Promise<boolean> {
  const resend = createResendClient(env);
  if (!resend || !env.resendFromEmail) {
    console.warn("[site] mail not sent — RESEND_API_KEY / RESEND_FROM_EMAIL unset (to:", message.to + ")");
    return false;
  }

  try {
    const { error } = await resend.emails.send(
      {
        from: env.resendFromEmail,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        ...(message.text === undefined ? {} : { text: message.text }),
        ...(message.headers === undefined ? {} : { headers: message.headers }),
        ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
      },
      message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : undefined,
    );
    if (error) {
      console.warn("[site] Resend send failed:", error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[site] Resend send failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

export async function sendMagicLinkEmail(env: SiteEnv, email: string, url: string): Promise<boolean> {
  try {
    const [html, text] = await Promise.all([
      render(createElement(MagicLinkEmail, { url })),
      render(createElement(MagicLinkEmail, { url }), { plainText: true }),
    ]);
    return await sendEmail(env, {
      to: email,
      subject: "Your Market Runs sign-in link",
      html,
      text,
    });
  } catch (error) {
    console.warn("[site] magic-link email rendering failed:", error instanceof Error ? error.message : error);
    return false;
  }
}
