import { getSite } from "../../../../src/server";

async function handle(request: Request) {
  const { auth } = await getSite();
  return auth.handler(request);
}

export { handle as GET, handle as POST };
