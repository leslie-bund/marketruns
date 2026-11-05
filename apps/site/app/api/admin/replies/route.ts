import { isAdminEmail } from "../../../../src/env";
import { sendInboundReply } from "../../../../src/replies";
import { getSessionContext } from "../../../../src/server";

export async function POST(request: Request) {
  const { env, site, user } = await getSessionContext();
  if (!user) return Response.json({ error: "authentication-required" }, { status: 401 });
  if (!isAdminEmail(env, user.email)) return Response.json({ error: "admin-required" }, { status: 403 });

  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object") return Response.json({ error: "invalid-reply" }, { status: 400 });
  const result = await sendInboundReply(env, site, input);
  return Response.json(result.body, { status: result.status });
}
