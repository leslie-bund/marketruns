import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { render } from "react-email";
import { z } from "zod";
import RegistrationConfirmationEmail from "../emails/registration-confirmation";
import { recordLeadRegistration, type SiteDatabase } from "./db";
import { sendEmail } from "./mailer";
import type { SiteEnv } from "./env";
import { upsertEarlyAccessContact } from "./resend-contacts";

export const registrationSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(320),
  interest: z.enum(["buyer", "seller", "runner", "partner"]),
  message: z.string().trim().max(2000).default(""),
  consent: z.preprocess((value) => value === true || value === "true", z.literal(true)),
});

async function sendConfirmation(env: SiteEnv, leadId: string, name: string, email: string): Promise<boolean> {
  try {
    const [html, text] = await Promise.all([
      render(createElement(RegistrationConfirmationEmail, { name })),
      render(createElement(RegistrationConfirmationEmail, { name }), { plainText: true }),
    ]);
    return await sendEmail(env, {
      to: email,
      subject: "We received your Market Runs registration",
      html,
      text,
      idempotencyKey: `lead-confirmation/${leadId}`,
    });
  } catch (error) {
    console.warn("[site] registration confirmation rendering failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

export async function registerLead(env: SiteEnv, site: SiteDatabase, input: unknown) {
  const parsed = registrationSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 400 as const, body: { error: "invalid-registration", issues: parsed.error.issues } };
  }

  const leadId = randomUUID();
  const [, confirmationSent] = await Promise.all([
    upsertEarlyAccessContact(env, parsed.data),
    sendConfirmation(env, leadId, parsed.data.name, parsed.data.email),
  ]);
  await recordLeadRegistration(site, {
    id: leadId,
    name: parsed.data.name,
    email: parsed.data.email,
    interest: parsed.data.interest,
    message: parsed.data.message,
    confirmation_sent: confirmationSent ? "sent" : "failed",
    created_at: new Date().toISOString(),
  });
  return { status: 201 as const, body: { ok: true, confirmationSent } };
}
