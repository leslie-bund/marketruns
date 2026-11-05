import type { SiteEnv } from "./env";
import { createResendClient } from "./resend";

interface EarlyAccessContact {
  name: string;
  email: string;
  interest: "buyer" | "seller" | "runner" | "partner";
}

function contactName(name: string): { firstName: string; lastName?: string } {
  const [firstName = "", ...rest] = name.trim().split(/\s+/);
  const lastName = rest.join(" ");
  return lastName ? { firstName, lastName } : { firstName };
}

export async function upsertEarlyAccessContact(env: SiteEnv, contact: EarlyAccessContact): Promise<boolean> {
  const resend = createResendClient(env);
  if (!resend || !env.resendAudienceId) return false;

  const name = contactName(contact.name);
  const details = {
    ...name,
    unsubscribed: false,
    properties: { interest: contact.interest },
  };

  try {
    const existing = await resend.contacts.get({
      audienceId: env.resendAudienceId,
      email: contact.email,
    });

    const contactNotFound = existing.error?.statusCode === 404;
    if (existing.error && !contactNotFound) {
      console.warn("[site] Resend contact lookup failed:", existing.error.message);
      return false;
    }

    const result = existing.data
      ? await resend.contacts.update({
          audienceId: env.resendAudienceId,
          email: contact.email,
          ...details,
        })
      : await resend.contacts.create({
          audienceId: env.resendAudienceId,
          email: contact.email,
          ...details,
        });

    if (result.error) {
      console.warn("[site] Resend audience contact upsert failed:", result.error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[site] Resend audience contact upsert failed:", error instanceof Error ? error.message : error);
    return false;
  }
}
