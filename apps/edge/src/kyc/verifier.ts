import type { IdDocumentType, KycVerificationStatus } from "@market-runs/proto";

/**
 * The identity-verifier seam (ADR-0009): the domain speaks in verifications,
 * never in vendor shapes — Smile/Dojah/VerifyMe integrate here, and no vendor
 * name crosses this boundary. The dev implementation checks document shape
 * and the presence of a facial capture; a real vendor replaces one function.
 */
export interface IdentityVerificationInput {
  participantId: string;
  idDocumentType: IdDocumentType;
  /** Raw BVN/NIN — verified and discarded, never stored. */
  idDocument: string;
  facialCaptureRef: string;
}

export interface IdentityVerifier {
  verify(input: IdentityVerificationInput): Promise<KycVerificationStatus>;
}

/** Dev verifier: BVN/NIN are 11 digits; a facial capture must be attached. */
export const devIdentityVerifier: IdentityVerifier = {
  async verify(input) {
    const digitsOk = /^\d{11}$/.test(input.idDocument);
    const captureOk = input.facialCaptureRef.startsWith("r2://archive/captures/");
    return digitsOk && captureOk ? "verified" : "failed";
  },
};

/** Keyed HMAC-SHA256; raw BVN/NIN and unkeyed, enumerable digests are never stored. */
export async function hashIdDocument(raw: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
