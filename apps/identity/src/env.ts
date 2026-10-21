import type { DatabaseEnv } from "./db.js";

/**
 * Identity worker bindings/vars (infra/wrangler.identity.toml). Every secret
 * has a clearly-labelled dev default so the stack runs out of the box — the
 * OPS_TOKEN posture (ADR-0015): deploys set real values via wrangler secrets;
 * the committed defaults are development-only and worthless against any
 * deployed environment.
 */
export interface Env extends DatabaseEnv {
  /**
   * AES-256-GCM key for embeddings at rest, base64-encoded 32 bytes.
   * Dev default below is a FIXED, PUBLIC key — dev databases only.
   */
  IDENTITY_ENCRYPTION_KEY?: string;
  /**
   * HMAC-SHA256 secret for session tokens. SHARED with the edge worker, which
   * verifies tokens locally (no per-request round trip — see session-token.ts
   * in packages/domain). Same dev default on both workers.
   */
  IDENTITY_SESSION_SECRET?: string;
  /**
   * Shared secret for internal routes (face enrollment after KYC, device-reset
   * decisions). OPS_TOKEN posture: when set, callers must carry it as
   * `x-identity-internal`; when unset (local dev) the routes are open and say
   * so in their responses' audit trail.
   */
  IDENTITY_INTERNAL_TOKEN?: string;
  /** Face verifier implementation selector: "stub" (default, dev) or "smileid" (vendor-held biometrics). */
  FACE_VERIFIER?: string;
  /** Cosine-similarity acceptance threshold; default 0.6 (packages/domain face-match). */
  FACE_MATCH_THRESHOLD?: string;
  /* -- Vendor quarantine config (read ONLY by apps/identity/src/smileid/) -- */
  /** Smile ID partner id + api key (Dashboard → Developer Settings). No dev default. */
  SMILEID_PARTNER_ID?: string;
  SMILEID_API_KEY?: string;
  /** "sandbox" (default) or "production" — selects the Smile ID base URL. */
  SMILEID_ENV?: string;
  /**
   * Optional per-request callback_url override for Smile ID jobs. When unset,
   * jobs fall back to the partner default callback URL configured in the
   * Smile ID Dashboard (per environment).
   */
  SMILEID_CALLBACK_URL?: string;
  /**
   * HTTPS URL of the privacy notice shown at capture time — forwarded in the
   * vendor consent record (NDPA 2023: biometrics are sensitive personal data).
   */
  SMILEID_PRIVACY_NOTICE_URL?: string;
  /**
   * "true" lets a second registration REPLACE the existing credential row for
   * (participant, type) instead of 409-ing — so multi-device testing can cycle
   * devices without an ops reset. Default off.
   */
  FIDO_UPSERT_ENABLED?: string;
  /**
   * "true" enables the clearly-labelled DEV PasskeyVerifier stub, which accepts
   * any assertion without verifying signatures. Real WebAuthn attestation/
   * assertion verification is TODO-real-vendor. Default off: fido routes 501.
   */
  FIDO_STUB_ENABLED?: string;
}

/**
 * DEV-ONLY defaults — fixed, public, and printed in code so nobody mistakes
 * them for secrets. wrangler secrets override both in any real deployment.
 */
export const DEV_ENCRYPTION_KEY_BASE64 = btoa("market-runs-dev-key-32-bytes!!!!"); // exactly 32 ASCII bytes
export const DEV_SESSION_SECRET = "market-runs-dev-session-secret";

export function encryptionKeyBase64(env: Env): string {
  return env.IDENTITY_ENCRYPTION_KEY ?? DEV_ENCRYPTION_KEY_BASE64;
}

export function sessionSecret(env: Env): string {
  return env.IDENTITY_SESSION_SECRET ?? DEV_SESSION_SECRET;
}

export function faceMatchThreshold(env: Env): number | undefined {
  if (!env.FACE_MATCH_THRESHOLD) return undefined;
  const parsed = Number.parseFloat(env.FACE_MATCH_THRESHOLD);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function fidoUpsertEnabled(env: Env): boolean {
  return env.FIDO_UPSERT_ENABLED === "true";
}

export function fidoStubEnabled(env: Env): boolean {
  return env.FIDO_STUB_ENABLED === "true";
}
