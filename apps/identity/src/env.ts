import type { DatabaseEnv } from "./db.js";

export interface Env extends DatabaseEnv {
  IDENTITY_ENV?: string;
  IDENTITY_ENCRYPTION_KEY?: string;
  IDENTITY_SESSION_SECRET?: string;
  IDENTITY_INTERNAL_TOKEN?: string;
  /** Public edge origin for identity → core KYC reconciliation. */
  EDGE_URL?: string;
  /** Native deployed Worker-to-Worker edge path; URL remains the local fallback. */
  EDGE_SERVICE?: Fetcher;
  FACE_VERIFIER?: string;
  FACE_MATCH_THRESHOLD?: string;
  BIOMETRICS_SERVICE_URL?: string;
  BIOMETRICS_SERVICE_TOKEN?: string;
  BIOMETRICS_TIMEOUT_MS?: string;
  IDENTITY_CAPTURES?: R2Bucket;
  SMILEID_PARTNER_ID?: string;
  SMILEID_API_KEY?: string;
  SMILEID_ENV?: string;
  SMILEID_CALLBACK_URL?: string;
  SMILEID_PRIVACY_NOTICE_URL?: string;
  FIDO_UPSERT_ENABLED?: string;
  FIDO_STUB_ENABLED?: string;
}

export const DEV_ENCRYPTION_KEY_BASE64 = btoa("market-runs-dev-key-32-bytes!!!!");
export const DEV_SESSION_SECRET = "market-runs-dev-session-secret";
export function isProduction(env: Env): boolean { return env.IDENTITY_ENV === "production"; }
export function isDeployed(env: Env): boolean {
  return env.IDENTITY_ENV === "staging" || isProduction(env);
}
function required(env: Env, value: string | undefined, name: string, dev: string): string {
  if (value) return value;
  if (isDeployed(env)) throw new Error(`${name} is required in deployed identity; no public fallback exists`);
  return dev;
}
export function encryptionKeyBase64(env: Env): string {
  return required(env, env.IDENTITY_ENCRYPTION_KEY, "IDENTITY_ENCRYPTION_KEY", DEV_ENCRYPTION_KEY_BASE64);
}
export function sessionSecret(env: Env): string {
  return required(env, env.IDENTITY_SESSION_SECRET, "IDENTITY_SESSION_SECRET", DEV_SESSION_SECRET);
}
export function faceMatchThreshold(env: Env): number | undefined {
  if (!env.FACE_MATCH_THRESHOLD) return undefined;
  const value = Number.parseFloat(env.FACE_MATCH_THRESHOLD);
  if (!Number.isFinite(value) || value < -1 || value > 1) throw new Error("FACE_MATCH_THRESHOLD must be between -1 and 1");
  return value;
}
export function fidoUpsertEnabled(env: Env): boolean { return !isProduction(env) && env.FIDO_UPSERT_ENABLED === "true"; }
export function fidoStubEnabled(env: Env): boolean { return !isProduction(env) && env.FIDO_STUB_ENABLED === "true"; }
