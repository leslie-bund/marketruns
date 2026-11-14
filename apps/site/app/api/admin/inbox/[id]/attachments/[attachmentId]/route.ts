import { getInboundAttachmentUrl } from "../../../../../../../src/attachments";
import { getInboundEmail } from "../../../../../../../src/db";
import { isAdminEmail } from "../../../../../../../src/env";
import { getSessionContext } from "../../../../../../../src/server";

const attachmentIdPattern = /^[A-Za-z0-9_-]+$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const { env, site, user } = await getSessionContext();
  if (!user) return Response.json({ error: "authentication-required" }, { status: 401 });
  if (!isAdminEmail(env, user.email)) return Response.json({ error: "admin-required" }, { status: 403 });

  const { id, attachmentId } = await params;
  if (!attachmentIdPattern.test(attachmentId)) {
    return Response.json({ error: "invalid-attachment" }, { status: 400 });
  }
  const email = await getInboundEmail(site, id);
  if (!email?.resend_email_id) return Response.json({ error: "email-not-found" }, { status: 404 });

  const downloadUrl = await getInboundAttachmentUrl(env, email.resend_email_id, attachmentId);
  if (!downloadUrl) return Response.json({ error: "attachment-unavailable" }, { status: 502 });

  return new Response(null, {
    status: 307,
    headers: { Location: downloadUrl, "Cache-Control": "private, no-store" },
  });
}
