import { z } from "zod";
import * as schemas from "./schemas.js";

export * from "./schemas.js";

/** Build a POST request addressed to a DO's internal route. */
export function internalPost(path: string, body: unknown, headers?: Headers): Request {
  const allHeaders = new Headers(headers);
  allHeaders.set("content-type", "application/json");
  return new Request(`http://do${path}`, {
    method: "POST",
    headers: allHeaders,
    body: JSON.stringify(body),
  });
}

/** Fetch an internal endpoint and parse the JSON response with a zod schema. */
export async function fetchInternal<S extends z.ZodTypeAny>(
  stub: DurableObjectStub,
  request: Request,
  schema: S,
): Promise<z.infer<S> | Response> {
  const response = await stub.fetch(request);
  if (!response.ok) return response;
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return new Response("internal endpoint returned non-JSON", { status: 502 });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "bad-internal-response", issues: parsed.error.issues }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
  return parsed.data;
}