import { getSite } from "../../../../src/server";
import { handleResendWebhook } from "../../../../src/webhooks/resend";

export async function POST(request: Request) {
  const { env, site } = await getSite();
  const result = await handleResendWebhook(
    await request.text(),
    {
      "svix-id": request.headers.get("svix-id") ?? undefined,
      "svix-timestamp": request.headers.get("svix-timestamp") ?? undefined,
      "svix-signature": request.headers.get("svix-signature") ?? undefined,
    },
    env,
    site,
  );
  return Response.json(result.body, { status: result.status });
}
