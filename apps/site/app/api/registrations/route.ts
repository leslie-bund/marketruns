import { registerLead } from "../../../src/registrations";
import { getSite } from "../../../src/server";

export async function POST(request: Request) {
  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object") {
    return Response.json({ error: "invalid-registration" }, { status: 400 });
  }
  const { env, site } = await getSite();
  const result = await registerLead(env, site, input);
  return Response.json(result.body, { status: result.status });
}
