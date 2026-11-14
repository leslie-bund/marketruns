import type { AttachmentData } from "resend";
import type { SiteEnv } from "./env";
import { createResendClient } from "./resend";

export async function listInboundAttachments(env: SiteEnv, emailId: string | null): Promise<AttachmentData[] | null> {
  const resend = createResendClient(env);
  if (!resend || !emailId) return null;

  const attachments: AttachmentData[] = [];
  let after: string | undefined;
  try {
    do {
      const { data, error } = await resend.emails.receiving.attachments.list({
        emailId,
        limit: 100,
        ...(after === undefined ? {} : { after }),
      });
      if (error || !data) {
        console.warn("[site] Resend attachment list failed:", error?.message ?? "empty response");
        return null;
      }
      attachments.push(...data.data);
      after = data.has_more ? data.data.at(-1)?.id : undefined;
      if (data.has_more && !after) return null;
    } while (after);
    return attachments;
  } catch (error) {
    console.warn("[site] Resend attachment list failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function getInboundAttachmentUrl(
  env: SiteEnv,
  emailId: string,
  attachmentId: string,
): Promise<string | null> {
  const resend = createResendClient(env);
  if (!resend) return null;

  try {
    const { data, error } = await resend.emails.receiving.attachments.get({ emailId, id: attachmentId });
    if (error || !data) {
      console.warn("[site] Resend attachment lookup failed:", error?.message ?? "empty response");
      return null;
    }
    const url = new URL(data.download_url);
    return url.protocol === "https:" ? url.toString() : null;
  } catch (error) {
    console.warn("[site] Resend attachment lookup failed:", error instanceof Error ? error.message : error);
    return null;
  }
}
