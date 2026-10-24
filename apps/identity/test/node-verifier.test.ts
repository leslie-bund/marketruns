import { describe, expect, it } from "vitest";
import { BiometricServiceError, NodeBiometricFaceVerifier, createLocalFaceVerifier } from "../src/face-verifier.js";
import type { Env } from "../src/env.js";

const embedding = Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0);
describe("NodeBiometricFaceVerifier", () => {
  it("calls only the private service with bearer auth and validates real response shape", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init }); return Response.json({ embedding, liveness: { live: true, confidence: 0.9 }, modelVersion: "fake-onnx-v1" });
    };
    const verifier = new NodeBiometricFaceVerifier("http://biometrics:8791", "private-token", 1000, fetchImpl as typeof fetch);
    const result = await verifier.analyze(new Uint8Array([1]), Array.from({ length: 7 }, (_, i) => new Uint8Array([i + 1])));
    expect(result.modelVersion).toBe("fake-onnx-v1"); expect(calls[0]?.url).toBe("http://biometrics:8791/v1/face/analyze");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer private-token");
    expect(JSON.parse(String(calls[0]?.init?.body)).frames).toHaveLength(7);
  });
  it("fails closed on liveness rejection and invalid model output", async () => {
    const rejecting = new NodeBiometricFaceVerifier("http://private", "token", 1000, (async () => Response.json({ error: "liveness-failed" }, { status: 422 })) as typeof fetch);
    await expect(rejecting.analyze(new Uint8Array([1]), [])).rejects.toBeInstanceOf(BiometricServiceError);
    const malformed = new NodeBiometricFaceVerifier("http://private", "token", 1000, (async () => Response.json({ embedding: [1], liveness: { live: true } })) as typeof fetch);
    await expect(malformed.analyze(new Uint8Array([1]), [])).rejects.toMatchObject({ code: "bad-identity-response" });
  });
  it("requires explicit service configuration outside the dev stub", () => {
    expect(() => createLocalFaceVerifier({ FACE_VERIFIER: "hybrid" } as Env)).toThrow(/BIOMETRICS_SERVICE_URL/);
  });
});
