import { Hono } from "hono";
import { errorResponse } from "../../do/runtime/index.js";
import type { Env } from "../../config/env.js";
import { runForParticipant } from "../run-access.js";

/**
 * The capture endpoint (ADR-0010): media bytes land in R2 behind this seam and
 * clients hold only the returned reference. Camera-only capture is a client
 * doctrine; this route just enforces size/type and stores bytes.
 *
 *   POST /captures  — raw image bytes (image/jpeg|png, ≤ 8 MB) → { ref, url }
 *   GET  /captures/:key — read-back so apps can render their own captures
 */
const MAX_BYTES = 8 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
};

export function capturesRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/", async (c) => {
    const who = c.get("participant");
    if (who.source === "anonymous" || who.source === "unauthenticated") {
      return errorResponse(401, "unauthorized", "a participant identity is required to upload captures");
    }
    const contentType = c.req.header("content-type")?.split(";")[0]?.trim() ?? "";
    const extension = CONTENT_TYPES[contentType];
    if (!extension) return errorResponse(415, "unsupported-media", "captures accept image/jpeg or image/png bytes");
    const runId = c.req.header("x-run-id");
    if (runId) {
      if (who.role !== "runner") return errorResponse(403, "forbidden", "only runners may upload run handoff evidence");
      const access = await runForParticipant(c.env, runId, who);
      if ("denied" in access) return access.denied;
    }
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0) return errorResponse(400, "empty-capture", "capture body is empty");
    if (bytes.byteLength > MAX_BYTES) return errorResponse(413, "capture-too-large", `capture exceeds ${MAX_BYTES} bytes`);
    const key = `captures/${crypto.randomUUID()}.${extension}`;
    await c.env.ARCHIVE_BUCKET.put(key, bytes, {
      httpMetadata: { contentType },
      customMetadata: { ownerId: who.id, ...(runId ? { runId } : {}) },
    });
    return c.json({ ref: `r2://archive/${key}`, url: `/captures/${encodeURIComponent(key)}`, bytes: bytes.byteLength });
  });

  app.get("/:key{.+}", async (c) => {
    const who = c.get("participant");
    if (who.source === "anonymous" || who.source === "unauthenticated") {
      return errorResponse(401, "unauthorized", "a participant identity is required to read captures");
    }
    const key = decodeURIComponent(c.req.param("key"));
    if (!key.startsWith("captures/")) return errorResponse(404, "not-found", "unknown capture");
    const object = await c.env.ARCHIVE_BUCKET.get(key);
    if (!object) return errorResponse(404, "not-found", "unknown capture");
    let allowed = object.customMetadata?.ownerId === who.id;
    const runId = object.customMetadata?.runId;
    if (!allowed && runId) {
      const access = await runForParticipant(c.env, runId, who);
      if ("denied" in access) return access.denied;
      const ref = `r2://archive/${key}`;
      allowed = access.run.handoffs.some((handoff) => handoff.photoCaptureRef === ref);
    }
    if (!allowed) return errorResponse(403, "forbidden", "capture is visible only to its owner and run participants");
    return new Response(object.body, {
      headers: {
        "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "cache-control": "private, no-store",
      },
    });
  });

  return app;
}
