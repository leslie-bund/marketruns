import type { Env } from "./config/env.js";
import { errorResponse } from "./do/runtime/index.js";

const ARCHIVE_REF_PREFIX = "r2://archive/";

export function captureObjectKey(ref: string): string | null {
  if (!ref.startsWith(ARCHIVE_REF_PREFIX) || ref.length === ARCHIVE_REF_PREFIX.length) return null;
  return ref.slice(ARCHIVE_REF_PREFIX.length);
}

export async function validateCaptureMedia(
  env: Env,
  input: {
    refs: Array<readonly [string | undefined, "image" | "video"]>;
    ownerId?: string | undefined;
    purpose: "product" | "intent";
  },
): Promise<Response | null> {
  for (const [ref, kind] of input.refs) {
    if (!ref) continue;
    const key = captureObjectKey(ref);
    if (!key) return errorResponse(400, "invalid-capture-media", "media must use an edge-issued capture reference");
    const object = await env.ARCHIVE_BUCKET.head(key);
    if (!object) return errorResponse(400, "invalid-capture-media", "media capture does not exist");
    if (object.customMetadata?.runId) return errorResponse(403, "invalid-capture-media", "run evidence cannot be attached here");
    const purpose = object.customMetadata?.mediaPurpose;
    if (purpose && purpose !== input.purpose) return errorResponse(403, "invalid-capture-media", `${purpose} media cannot be attached as ${input.purpose} media`);
    if (input.ownerId && object.customMetadata?.ownerId !== input.ownerId) {
      return errorResponse(403, "invalid-capture-media", "media must be captured by the participant attaching it");
    }
    const expectedType = kind === "image" ? "image/" : "video/";
    if (!object.httpMetadata?.contentType?.startsWith(expectedType)) {
      return errorResponse(400, "invalid-capture-media", `${kind} reference contains a different media type`);
    }
  }
  return null;
}
