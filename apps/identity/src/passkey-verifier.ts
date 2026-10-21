import type { Env } from "./env.js";
import { fidoStubEnabled } from "./env.js";

/**
 * The FIDO/passkey seam — an INTERFACE AND A DEV STUB, deliberately.
 *
 * Reference stacks have shipped a skeleton here that "verified" assertions
 * without ever checking a cryptographic signature. That mistake is not
 * repeated: real WebAuthn attestation/assertion verification is
 * TODO-real-vendor, and the only implementation below is a loudly-labelled
 * DEV stub gated behind FIDO_STUB_ENABLED=true. With the gate off (the
 * default everywhere), the fido routes return 501 fido-not-implemented.
 */
export interface PasskeyVerifier {
  /**
   * Verify a registration attestation and return the credential public key
   * to store. Real impl: parse the attestation object, verify the attestation
   * signature against a trusted authenticator root, extract the public key.
   */
  verifyRegistration(attestation: string): Promise<{ publicKey: string }>;
  /**
   * Verify an authentication assertion against the stored public key.
   * Real impl: verify the assertion signature, check the challenge, origin,
   * and sign counter.
   */
  verifyAssertion(publicKey: string, assertion: string): Promise<boolean>;
}

/**
 * DEV STUB — FIDO_STUB_ENABLED=true only. Performs NO signature
 * verification: any attestation "registers" and any assertion "passes".
 * Exists so the credential lifecycle (register → authenticate → revoke →
 * reset) is exercisable end-to-end before a real WebAuthn vendor lands.
 */
export class DevStubPasskeyVerifier implements PasskeyVerifier {
  async verifyRegistration(attestation: string): Promise<{ publicKey: string }> {
    if (!attestation) throw new RangeError("DevStubPasskeyVerifier: empty attestation");
    return { publicKey: `dev-stub-public-key:${attestation.slice(0, 32)}` };
  }
  async verifyAssertion(): Promise<boolean> {
    return true; // NO cryptography — dev stub, gated by FIDO_STUB_ENABLED.
  }
}

/**
 * Returns the dev stub when explicitly enabled, null otherwise — callers
 * turn null into 501 fido-not-implemented rather than a silent pass.
 */
export function createPasskeyVerifier(env: Env): PasskeyVerifier | null {
  return fidoStubEnabled(env) ? new DevStubPasskeyVerifier() : null;
}
