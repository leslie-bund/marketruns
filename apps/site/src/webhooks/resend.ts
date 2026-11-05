import { randomUUID } from "node:crypto";
import { Webhook } from "svix";
import { z } from "zod";
import type { SiteEnv } from "../env";
import { insertInboundEmail, type SiteDatabase } from "../db";

/**
 * Resend inbound email (`email.received`) payload. Bodies are not inlined in the event;
 * when RESEND_API_KEY is configured the full message is fetched from the receiving API.
 */
const resendEventSchema = z.object({
  type: z.string(),
  created_at: z.string().optional(),
  data: z
    .object({
      email_id: z.string().optional(),
      from: z.string().optional(),
      to: z.array(z.string()).optional(),
      cc: z.array(z.string()).optional(),
      bcc: z.array(z.string()).optional(),
      subject: z.string().optional(),
      message_id: z.string().optional(),
      created_at: z.string().optional(),
    })
    .passthrough(),
});

const receivedBodySchema = z.object({
  text: z.string().nullish(),
  html: z.string().nullish(),
});

export interface WebhookResult {
  status: 200 | 401 | 503;
  body: Record<string, unknown>;
}

async function fetchReceivedBodies(env: SiteEnv, emailId: string): Promise<{ text: string | null; html: string | null }> {
  if (!env.resendApiKey) return { text: null, html: null };
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { authorization: `Bearer ${env.resendApiKey}` },
    });
    if (!res.ok) {
      console.warn("[site] resend receiving API answered", res.status, "for email", emailId);
      return { text: null, html: null };
    }
    const parsed = receivedBodySchema.safeParse(await res.json());
    if (!parsed.success) return { text: null, html: null };
    return { text: parsed.data.text ?? null, html: parsed.data.html ?? null };
  } catch (error) {
    console.warn("[site] failed to fetch received email body:", error instanceof Error ? error.message : error);
    return { text: null, html: null };
  }
}

export async function handleResendWebhook(
  rawBody: string,
  headers: { "svix-id"?: string | undefined; "svix-timestamp"?: string | undefined; "svix-signature"?: string | undefined },
  env: SiteEnv,
  site: SiteDatabase,
): Promise<WebhookResult> {
  if (!env.resendWebhookSecret) {
    return {
      status: 503,
      body: { error: "webhook-not-configured", message: "set RESEND_WEBHOOK_SECRET from the Resend dashboard" },
    };
  }

  let payload: unknown;
  try {
    const wh = new Webhook(env.resendWebhookSecret);
    payload = wh.verify(rawBody, {
      "svix-id": headers["svix-id"] ?? "",
      "svix-timestamp": headers["svix-timestamp"] ?? "",
      "svix-signature": headers["svix-signature"] ?? "",
    });
  } catch {
    return { status: 401, body: { error: "invalid-signature" } };
  }

  const parsed = resendEventSchema.safeParse(payload);
  if (!parsed.success) {
    return { status: 200, body: { ok: true, ignored: "unrecognised-payload" } };
  }

  const event = parsed.data;
  if (event.type !== "email.received") {
    return { status: 200, body: { ok: true, ignored: event.type } };
  }

  const emailId = event.data.email_id ?? null;
  const bodies = emailId ? await fetchReceivedBodies(env, emailId) : { text: null, html: null };
  await insertInboundEmail(site, {
    id: randomUUID(),
    event_type: event.type,
    resend_email_id: emailId,
    from_address: event.data.from ?? "",
    to_addresses: JSON.stringify(event.data.to ?? []),
    subject: event.data.subject ?? "",
    text_body: bodies.text,
    html_body: bodies.html,
    raw_payload: rawBody,
    received_at: event.data.created_at ?? event.created_at ?? new Date().toISOString(),
  });
  return { status: 200, body: { ok: true, stored: emailId } };
}
