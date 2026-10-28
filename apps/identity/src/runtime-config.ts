import type { Env } from "./env.js";
import { encryptionKeyBase64, isProduction, sessionSecret } from "./env.js";

/** Validate the complete production posture before health checks or database work. */
export function validateIdentityRuntime(env: Env): void {
  if (!isProduction(env)) return;
  encryptionKeyBase64(env);
  sessionSecret(env);
  const missing = [
    !env.IDENTITY_INTERNAL_TOKEN && "IDENTITY_INTERNAL_TOKEN",
    !env.DATABASE_URL && !env.HYPERDRIVE?.connectionString && "DATABASE_URL or HYPERDRIVE",
    !env.BIOMETRICS_SERVICE_URL && "BIOMETRICS_SERVICE_URL",
    !env.BIOMETRICS_SERVICE_TOKEN && "BIOMETRICS_SERVICE_TOKEN",
    !env.SMILEID_PARTNER_ID && "SMILEID_PARTNER_ID",
    !env.SMILEID_API_KEY && "SMILEID_API_KEY",
    !env.IDENTITY_CAPTURES && "IDENTITY_CAPTURES",
  ].filter((name): name is string => typeof name === "string");
  if (env.FACE_VERIFIER !== "hybrid") missing.unshift("FACE_VERIFIER=hybrid");
  if (missing.length > 0) throw new Error(`production identity configuration is incomplete: ${missing.join(", ")}`);

  let biometrics: URL;
  try {
    biometrics = new URL(env.BIOMETRICS_SERVICE_URL!);
  } catch {
    throw new Error("BIOMETRICS_SERVICE_URL must be an absolute HTTPS URL in production");
  }
  const hostname = biometrics.hostname.toLowerCase();
  if (biometrics.protocol !== "https:" || ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"].includes(hostname) || hostname.endsWith(".localhost")) {
    throw new Error("BIOMETRICS_SERVICE_URL must be a non-local HTTPS URL in production");
  }
}
