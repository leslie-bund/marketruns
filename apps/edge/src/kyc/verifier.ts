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

/** SHA-256 of a raw document number; the edge stores only the hash. */
export async function hashIdDocument(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
