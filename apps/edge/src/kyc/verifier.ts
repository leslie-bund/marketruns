import type { IdDocumentType, KycVerificationStatus } from "@market-runs/proto";

/**
 * The identity-verifier seam (ADR-0009): the domain speaks in verifications,
 * never in vendor shapes. Raw biometrics use the direct identity capture flow,
 * never this document-only onboarding seam or a public capture reference.
 */
export interface IdentityVerificationInput {
  participantId: string;
  idDocumentType: IdDocumentType;
  /** Raw BVN/NIN — verified and discarded, never stored. */
  idDocument: string;
}

export interface IdentityVerifier {
  verify(input: IdentityVerificationInput, explicitStaging: boolean): Promise<KycVerificationStatus>;
}

/** Dev shape checks never constitute verified KYC. Real KYC remains asynchronous and pending. */
export const devIdentityVerifier: IdentityVerifier = {
  async verify(input, explicitStaging) {
    if (!/^\d{11}$/.test(input.idDocument)) return "failed";
    return explicitStaging ? "preverified" : "pending";
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
