import { getSite } from "../../src/server";

export async function GET() {
  await getSite();
  return Response.json({ ok: true, service: "market-runs-site" });
}
