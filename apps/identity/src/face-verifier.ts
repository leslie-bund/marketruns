import { FACE_EMBEDDING_DIMS, l2Normalize } from "@market-runs/domain";
import type { FaceUserDetails } from "@market-runs/proto";
import type { Env } from "./env.js";
import { createSmileIdFaceVerifier } from "./smileid/index.js";

/**
 * The vendor-neutral face-verification seam (ADR-0009). Vendor names NEVER
 * appear in domain code — a real provider (liveness + embedding model)
 * implements this interface behind the integration layer and is selected by
 * the FACE_VERIFIER env var.
 */
export interface FaceVerifier {
  /** Vendor-neutral model label recorded with each enrollment. */
  readonly modelVersion: string;
  /** Image bytes → L2-normalized 512-dim embedding. */
  embed(imageBytes: Uint8Array): Promise<number[]>;
  /** Optional liveness over captured frames (real vendors; stub omits it). */
  livenessCheck?(frames: Uint8Array[]): Promise<{ live: boolean; confidence: number }>;
}

/* ------------------------------------------------------------------------ */
/* Async providers (vendor-held biometrics) — additive seam                  */
/* ------------------------------------------------------------------------ */

/**
 * A provider that holds the biometric reference itself and processes
 * enroll/verify as async jobs (submit → callback/poll) instead of returning
 * an embedding synchronously. Additive to FaceVerifier: the app narrows with
 * isAsyncFaceVerifier and follows the pending-honest flow (202 + job id, GET
 * /auth/face/job/:id, /callbacks/:provider).
 */
export interface AsyncFaceVerifier {
  readonly modelVersion: string;
  readonly asyncJobs: true;
  /** The /callbacks/:provider path segment this verifier answers for. */
  readonly callbackProvider: string;
  submitEnrollment(input: FaceJobSubmissionInput): Promise<{ providerJobId: string }>;
  submitAuthentication(input: FaceJobSubmissionInput): Promise<{ providerJobId: string }>;
  /** Poll the provider for a job's verdict; "pending" means still processing. */
  pollJob(providerJobId: string): Promise<FaceJobVerdict>;
  /**
   * Verify a provider callback's authenticity and parse it. Returns null when
   * the signature is missing/invalid — the route answers 401.
   */
  handleCallback(request: Request): Promise<FaceCallbackVerdict | null>;
}

export interface FaceJobSubmissionInput {
  participantId: string;
  selfie: Uint8Array;
  /** Liveness sequence frames; providers that require them get a documented fallback when empty. */
  livenessImages: Uint8Array[];
  userDetails?: FaceUserDetails | undefined;
  /** Enrollment only: allow replacing an existing provider-side enrollment (device-reset re-enrollment). */
  allowNewEnroll?: boolean | undefined;
}

export type FaceJobVerdict =
  | { outcome: "pending" }
  | { outcome: "passed" }
  | { outcome: "failed"; reason: string | null };

export interface FaceCallbackVerdict {
  providerJobId: string;
  /** Provider-side user reference (== participantId for our submissions). */
  userRef: string;
  passed: boolean;
  /** Machine-readable failure reason from the provider; null on pass. */
  reason: string | null;
}

export function isAsyncFaceVerifier(v: FaceVerifier | AsyncFaceVerifier): v is AsyncFaceVerifier {
  return (v as AsyncFaceVerifier).asyncJobs === true;
}

/**
 * DEV STUB — zero security value. Derives a deterministic pseudo-embedding
 * from the image bytes (SHA-512 sponge expanded to 512 dims, L2-normalized):
 * identical bytes always produce the identical embedding, and different
 * bytes produce statistically independent ones. That is exactly enough to
 * exercise enroll → verify → match/mismatch end-to-end in dev and tests,
 * and nothing more: it has no notion of faces, cannot generalize across two
 * photos of the same person, and must never gate a real login. A real vendor
 * implementation replaces this class behind the same interface (ADR-0009).
 */
export class StubFaceVerifier implements FaceVerifier {
  readonly modelVersion = "stub-sha512-dev";

  async embed(imageBytes: Uint8Array): Promise<number[]> {
    if (imageBytes.length === 0) throw new RangeError("StubFaceVerifier.embed: empty image");
    const seed = await crypto.subtle.digest("SHA-512", imageBytes as BufferSource);
    const dims: number[] = [];
    // 8 rounds × 64 bytes = 512 dims. Round input: seed ‖ round-index byte.
    for (let round = 0; round < FACE_EMBEDDING_DIMS / 64; round += 1) {
      const input = new Uint8Array(seed.byteLength + 1);
      input.set(new Uint8Array(seed), 0);
      input[seed.byteLength] = round;
      const digest = await crypto.subtle.digest("SHA-512", input);
      for (const byte of new Uint8Array(digest)) {
        dims.push(byte / 127.5 - 1); // byte → [-1, 1]
      }
    }
    return l2Normalize(dims);
  }
}

/**
 * Select the verifier implementation. "stub" (default) is the self-held dev
 * path; "smileid" is the vendor-held async path (apps/identity/src/smileid —
 * the only module, besides this selector, where the vendor name appears).
 */
export function createFaceVerifier(env: Env): FaceVerifier | AsyncFaceVerifier {
  const selector = env.FACE_VERIFIER ?? "stub";
  if (selector === "stub") return new StubFaceVerifier();
  if (selector === "smileid") {
    return createSmileIdFaceVerifier(env);
  }
  throw new Error(`FACE_VERIFIER=${selector} is not implemented — valid values: "stub", "smileid" (ADR-0009 seam)`);
}
