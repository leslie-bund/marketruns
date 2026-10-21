import { Hono } from "hono";
import { errorResponse } from "../../do/runtime/index.js";
import type { Env } from "../../config/env.js";

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
    const contentType = c.req.header("content-type")?.split(";")[0]?.trim() ?? "";
    const extension = CONTENT_TYPES[contentType];
    if (!extension) {
      return errorResponse(415, "unsupported-media", "captures accept image/jpeg or image/png bytes");
    }
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0) {
      return errorResponse(400, "empty-capture", "capture body is empty");
    }
    if (bytes.byteLength > MAX_BYTES) {
      return errorResponse(413, "capture-too-large", `capture exceeds ${MAX_BYTES} bytes`);
    }
    const key = `captures/${crypto.randomUUID()}.${extension}`;
    await c.env.ARCHIVE_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
    return c.json({
      ref: `r2://archive/${key}`,
      url: `/captures/${encodeURIComponent(key)}`,
      bytes: bytes.byteLength,
    });
  });

  app.get("/:key{.+}", async (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    if (!key.startsWith("captures/")) {
      return errorResponse(404, "not-found", "unknown capture");
    }
    const object = await c.env.ARCHIVE_BUCKET.get(key);
    if (!object) return errorResponse(404, "not-found", "unknown capture");
    return new Response(object.body, {
      headers: { "content-type": object.httpMetadata?.contentType ?? "application/octet-stream" },
    });
  });

  return app;
}
