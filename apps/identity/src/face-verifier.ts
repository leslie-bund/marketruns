import { FACE_EMBEDDING_DIMS, l2Normalize } from "@market-runs/domain";
import type { FaceUserDetails, IdentityDocument } from "@market-runs/proto";
import type { Env } from "./env.js";
import { isProduction } from "./env.js";
import { createSmileIdFaceVerifier } from "./smileid/index.js";

export interface FaceAnalysis { embedding: number[]; liveness: { live: boolean; confidence: number }; modelVersion: string }
export interface FaceVerifier {
  readonly modelVersion: string;
  embed(image: Uint8Array): Promise<number[]>;
  analyze(image: Uint8Array, frames: Uint8Array[]): Promise<FaceAnalysis>;
}
export interface AsyncFaceVerifier {
  readonly modelVersion: string; readonly asyncJobs: true; readonly callbackProvider: string;
  submitEnrollment(input: FaceJobSubmissionInput): Promise<{ providerJobId: string }>;
  pollJob(id: string): Promise<FaceJobVerdict>;
  handleCallback(request: Request): Promise<FaceCallbackVerdict | null>;
}
export interface FaceJobSubmissionInput {
  participantId: string; selfie: Uint8Array; livenessImages: Uint8Array[];
  userDetails?: FaceUserDetails | undefined; identityDocument?: IdentityDocument | undefined;
  consent: { version: string; grantedAt: number };
}
export type FaceJobVerdict =
  | { outcome: "pending" }
  | { outcome: "passed"; verifiedLegalName?: string | null; providerImage?: Uint8Array | null }
  | { outcome: "failed"; reason: string | null };
export interface FaceCallbackVerdict {
  providerJobId: string; userRef: string; passed: boolean; reason: string | null;
  verifiedLegalName?: string | null; providerImage?: Uint8Array | null;
}
export function isAsyncFaceVerifier(v: FaceVerifier | AsyncFaceVerifier): v is AsyncFaceVerifier {
  return (v as AsyncFaceVerifier).asyncJobs === true;
}

/** Development-only deterministic pseudo-biometric. It has zero security value. */
export class StubFaceVerifier implements FaceVerifier {
  readonly modelVersion = "stub-sha512-dev";
  async embed(image: Uint8Array): Promise<number[]> {
    if (!image.length) throw new RangeError("empty image");
    const seed = await crypto.subtle.digest("SHA-512", image as BufferSource); const dims: number[] = [];
    for (let round = 0; round < FACE_EMBEDDING_DIMS / 64; round++) {
      const input = new Uint8Array(seed.byteLength + 1); input.set(new Uint8Array(seed)); input[seed.byteLength] = round;
      for (const byte of new Uint8Array(await crypto.subtle.digest("SHA-512", input))) dims.push(byte / 127.5 - 1);
    }
    return l2Normalize(dims);
  }
  async analyze(image: Uint8Array, frames: Uint8Array[]): Promise<FaceAnalysis> {
    if (frames.length < 6 || frames.length > 8) throw new Error("6-8 frames required");
    return { embedding: await this.embed(image), liveness: { live: true, confidence: 1 }, modelVersion: this.modelVersion };
  }
}

/** Real server-to-server adapter. The private service key is never available to mobile. */
export class NodeBiometricFaceVerifier implements FaceVerifier {
  readonly modelVersion = "node-onnx";
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly timeoutMs = 15_000,
    private readonly fetchImpl: typeof fetch = fetch) {}
  async embed(image: Uint8Array): Promise<number[]> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/v1/face/embed`, {
      method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ image: bytesToBase64(image) }),
    });
    const body = await res.json().catch(() => ({})) as { embedding?: number[] };
    if (!res.ok || body.embedding?.length !== FACE_EMBEDDING_DIMS) throw new BiometricServiceError(res.status, "bad-identity-response");
    return body.embedding;
  }
  async analyze(image: Uint8Array, frames: Uint8Array[]): Promise<FaceAnalysis> { return this.request(image, frames); }
  private async request(image: Uint8Array, frames: Uint8Array[]): Promise<FaceAnalysis> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/v1/face/analyze`, {
        method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({ image: bytesToBase64(image), frames: frames.map(bytesToBase64) }), signal: controller.signal,
      });
      const body = await res.json().catch(() => ({})) as Partial<FaceAnalysis> & { error?: string; reason?: string };
      if (!res.ok) throw new BiometricServiceError(res.status, body.error ?? "identity-unavailable", body.reason);
      if (!Array.isArray(body.embedding) || body.embedding.length !== FACE_EMBEDDING_DIMS || !body.liveness?.live || !body.modelVersion) {
        throw new BiometricServiceError(502, "bad-identity-response", "invalid biometric service response");
      }
      return body as FaceAnalysis;
    } finally { clearTimeout(timer); }
  }
}
export class BiometricServiceError extends Error {
  constructor(readonly status: number, readonly code: string, readonly reason?: string) { super(reason ?? code); }
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary);
}
export function createFaceVerifier(env: Env): FaceVerifier | AsyncFaceVerifier {
  const selector = env.FACE_VERIFIER ?? (isProduction(env) ? "hybrid" : "stub");
  if (selector === "stub") {
    if (isProduction(env)) throw new Error("stub face verifier is forbidden in production");
    return new StubFaceVerifier();
  }
  if (selector === "smileid" || selector === "hybrid") return createSmileIdFaceVerifier(env);
  if (selector === "node") return createLocalFaceVerifier(env);
  throw new Error(`FACE_VERIFIER=${selector} is not implemented`);
}
export function createLocalFaceVerifier(env: Env): FaceVerifier {
  if (env.FACE_VERIFIER === "stub" || (!env.FACE_VERIFIER && !isProduction(env))) return new StubFaceVerifier();
  const url = env.BIOMETRICS_SERVICE_URL; const token = env.BIOMETRICS_SERVICE_TOKEN;
  if (!url || !token) throw new Error("BIOMETRICS_SERVICE_URL and BIOMETRICS_SERVICE_TOKEN are required for hybrid/node mode");
  return new NodeBiometricFaceVerifier(url, token, Number(env.BIOMETRICS_TIMEOUT_MS ?? "15000"));
}
