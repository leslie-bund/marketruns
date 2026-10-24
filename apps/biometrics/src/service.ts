import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

export interface LivenessVerdict { live: boolean; confidence: number; reason: string | null }
export interface BiometricModel {
  readonly modelVersion: string;
  embed(image: Buffer): Promise<Float32Array>;
  liveness(frames: Buffer[]): Promise<LivenessVerdict>;
}
const AnalyzeSchema = z.object({ image: z.string().min(1), frames: z.array(z.string().min(1)).min(6).max(8) });
const MAX_BODY_BYTES = 96 * 1024 * 1024;

function authorized(header: string | undefined, token: string): boolean {
  const actual = Buffer.from(header ?? ""); const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function response(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) }); res.end(data);
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error("capture payload too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function decode(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024 || bytes.toString("base64") !== value) throw new Error("invalid base64 capture");
  return bytes;
}
export function createBiometricHandler(model: BiometricModel, internalToken: string) {
  if (internalToken.length < 32) throw new Error("BIOMETRICS_INTERNAL_TOKEN must contain at least 32 characters");
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method === "GET" && req.url === "/healthz") return response(res, 200, { ok: true, service: "market-runs-biometrics", modelVersion: model.modelVersion });
      if (!authorized(req.headers.authorization, internalToken)) return response(res, 401, { error: "unauthorized" });
      if (req.method !== "POST" || (req.url !== "/v1/face/analyze" && req.url !== "/v1/face/embed")) return response(res, 404, { error: "not-found" });
      const inputBody = await body(req);
      if (req.url === "/v1/face/embed") {
        const input = z.object({ image: z.string().min(1) }).safeParse(inputBody);
        if (!input.success) return response(res, 400, { error: "invalid-request" });
        const embedding = await model.embed(decode(input.data.image));
        if (embedding.length !== 512) return response(res, 502, { error: "invalid-model-output" });
        return response(res, 200, { embedding: Array.from(embedding), modelVersion: model.modelVersion });
      }
      const parsed = AnalyzeSchema.safeParse(inputBody);
      if (!parsed.success) return response(res, 400, { error: "invalid-request", issues: parsed.error.issues });
      const image = decode(parsed.data.image); const frames = parsed.data.frames.map(decode);
      if (new Set(frames.map((f) => createHash("sha256").update(f).digest("hex"))).size < 3) {
        return response(res, 422, { error: "liveness-failed", reason: "insufficient-distinct-frames" });
      }
      // Both real model invocations are mandatory. A failed liveness never falls back to a pass.
      const liveness = await model.liveness(frames);
      if (!liveness.live) return response(res, 422, { error: "liveness-failed", reason: liveness.reason ?? "not-live" });
      const embedding = await model.embed(image);
      if (embedding.length !== 512 || [...embedding].some((v) => !Number.isFinite(v))) return response(res, 502, { error: "invalid-model-output" });
      return response(res, 200, { embedding: Array.from(embedding), liveness, modelVersion: model.modelVersion });
    } catch (error) {
      return response(res, 400, { error: "invalid-request", message: error instanceof Error ? error.message : "invalid capture" });
    }
  };
}
