import { Hono } from "hono";
import { errorResponse } from "../../do/runtime/index.js";
import type { Env } from "../../config/env.js";
import { runForParticipant } from "../run-access.js";

/**
 * The capture endpoint (ADR-0010): media bytes land in R2 behind this seam and
 * clients hold only the returned reference. Camera-only capture is a client
 * doctrine; this route enforces size/type and the 15-second video limit.
 *
 *   POST /captures  — image/jpeg|png ≤ 8 MB or video/mp4|quicktime ≤ 50 MB
 *   GET  /captures/:key — read-back so apps can render their own captures
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_DURATION_MS = 15_000;
const CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
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
    if (!extension) return errorResponse(415, "unsupported-media", "captures accept JPEG, PNG, MP4, or QuickTime bytes");
    const video = contentType.startsWith("video/");
    const durationMs = Number(c.req.header("x-capture-duration-ms"));
    if (video && (!Number.isInteger(durationMs) || durationMs <= 0 || durationMs > MAX_VIDEO_DURATION_MS)) {
      return errorResponse(400, "invalid-video-duration", "product videos must declare a duration from 1 to 15000 milliseconds");
    }
    const runId = c.req.header("x-run-id");
    const requestedPurpose = c.req.header("x-capture-purpose");
    if (runId && requestedPurpose && requestedPurpose !== "run-evidence") {
      return errorResponse(400, "invalid-capture-purpose", "run captures are always run evidence");
    }
    const purpose = runId ? "run-evidence" : requestedPurpose ?? "product";
    if (purpose !== "run-evidence" && purpose !== "product" && purpose !== "intent") {
      return errorResponse(400, "invalid-capture-purpose", "capture purpose must be product, intent, or run-evidence");
    }
    if (purpose === "intent" && who.role !== "buyer") return errorResponse(403, "forbidden", "only buyers may upload intent media");
    if (runId) {
      if (who.role !== "runner") return errorResponse(403, "forbidden", "only runners may upload run handoff evidence");
      if (video) return errorResponse(415, "unsupported-media", "run handoff evidence remains photo-only");
      const access = await runForParticipant(c.env, runId, who);
      if ("denied" in access) return access.denied;
    }
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0) return errorResponse(400, "empty-capture", "capture body is empty");
    const maxBytes = video ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (bytes.byteLength > maxBytes) return errorResponse(413, "capture-too-large", `capture exceeds ${maxBytes} bytes`);
    const key = runId
      ? `evidence/runs/${runId}/${crypto.randomUUID()}.${extension}`
      : `${purpose === "intent" ? "intents" : "products"}/captures/${crypto.randomUUID()}.${extension}`;
    await c.env.ARCHIVE_BUCKET.put(key, bytes, {
      httpMetadata: { contentType },
      customMetadata: {
        ownerId: who.id,
        mediaKind: video ? "video" : "image",
        mediaPurpose: purpose,
        ...(runId ? { runId } : {}),
      },
    });
    return c.json({ ref: `r2://archive/${key}`, url: `/captures/${encodeURIComponent(key)}`, bytes: bytes.byteLength });
  });

  app.get("/:key{.+}", async (c) => {
    const who = c.get("participant");
    if (who.source === "anonymous" || who.source === "unauthenticated") {
      return errorResponse(401, "unauthorized", "a participant identity is required to read captures");
    }
    const key = decodeURIComponent(c.req.param("key"));
    if (!["captures/", "products/captures/", "intents/captures/", "evidence/runs/"].some((prefix) => key.startsWith(prefix))) {
      return errorResponse(404, "not-found", "unknown capture");
    }
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
