import { randomUUID } from "node:crypto";
import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import { getInboundEmail, recordEmailReply, type SiteDatabase } from "./db";
import { sendEmail } from "./mailer";
import type { SiteEnv } from "./env";

export const replySchema = z.object({
  inboundEmailId: z.string().uuid(),
  html: z.string().max(30000),
  text: z.string().trim().min(1).max(10000),
});

const inboundMessageSchema = z.object({
  data: z.object({ message_id: z.string().optional() }).passthrough(),
});
const messageIdPattern = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function isSafeLink(href: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(href).protocol);
  } catch {
    return false;
  }
}

function sanitizeReplyHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ["p", "br", "strong", "em", "ul", "ol", "li", "a", "blockquote"],
    allowedAttributes: { a: ["href"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href"],
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attributes) => ({
        tagName,
        attribs: attributes.href && isSafeLink(attributes.href) ? { href: attributes.href } : {},
      }),
    },
  });
}

function replyThreadHeaders(rawPayload: string): Record<string, string> | undefined {
  try {
    const parsed = inboundMessageSchema.safeParse(JSON.parse(rawPayload));
    const original = parsed.success ? parsed.data.data.message_id?.trim() : undefined;
    if (!original || original.length > 998) return undefined;
    const unwrapped = original.startsWith("<") && original.endsWith(">") ? original.slice(1, -1) : original;
    if (!messageIdPattern.test(unwrapped)) return undefined;
    const messageId = `<${unwrapped}>`;
    return { "In-Reply-To": messageId, References: messageId };
  } catch {
    return undefined;
  }
}

export async function sendInboundReply(env: SiteEnv, site: SiteDatabase, input: unknown) {
  const parsed = replySchema.safeParse(input);
  if (!parsed.success) return { status: 400 as const, body: { error: "invalid-reply" } };

  const inbound = await getInboundEmail(site, parsed.data.inboundEmailId);
  if (!inbound) return { status: 404 as const, body: { error: "email-not-found" } };

  const replyId = randomUUID();
  const subject = inbound.subject.replace(/^re:\s*/i, "");
  const replySubject = `Re: ${subject || "Your message to Market Runs"}`;
  const html = sanitizeReplyHtml(parsed.data.html);
  const threadHeaders = replyThreadHeaders(inbound.raw_payload);
  const sent = await sendEmail(env, {
    to: inbound.from_address,
    subject: replySubject,
    text: parsed.data.text,
    html,
    ...(threadHeaders === undefined ? {} : { headers: threadHeaders }),
    idempotencyKey: `email-reply/${replyId}`,
  });
  await recordEmailReply(site, {
    id: replyId,
    inbound_email_id: inbound.id,
    to_address: inbound.from_address,
    subject: replySubject,
    text_body: parsed.data.text,
    html_body: html,
    status: sent ? "sent" : "failed",
    created_at: new Date().toISOString(),
  });

  return sent
    ? { status: 200 as const, body: { ok: true } }
    : { status: 502 as const, body: { error: "reply-not-sent" } };
}
