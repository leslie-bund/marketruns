import { z } from "zod";
import { errorResponse } from "./responses.js";

/** Validate an internal DO-to-DO request body against its zod schema. */

export type ParsedInternal<S extends z.ZodTypeAny> =
  | { ok: true; data: z.infer<S> }
  | { ok: false; response: Response };

export async function parseInternal<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<ParsedInternal<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: errorResponse(400, "invalid-body", "request body is not valid JSON") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: errorResponse(400, "invalid-body", "request body failed schema validation", { issues: parsed.error.issues }) };
  }
  return { ok: true, data: parsed.data };
}
