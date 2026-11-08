import type { Env } from "./env.js";
import { encryptionKeyBase64, isDeployed, sessionSecret } from "./env.js";

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"];
const EXAMPLE_HOSTNAMES = ["example.com", "example.org", "example.net", "example"];

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.includes(hostname) || hostname.endsWith(".localhost");
}

function nonLocalHttps(value: string, name: string, scope = "deployed identity"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute non-local HTTPS URL in ${scope}`);
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || isLoopback(hostname)) {
    throw new Error(`${name} must be an absolute non-local HTTPS URL in ${scope}`);
  }
  return url;
}

/** Local service URLs may use HTTP only on loopback; remote services need HTTPS. */
function localServiceUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL or loopback HTTP URL in local hybrid identity`);
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(hostname))) return url;
  throw new Error(`${name} must be an absolute HTTPS URL or loopback HTTP URL in local hybrid identity`);
}

function requireRealPrivacyNotice(url: URL): void {
  const hostname = url.hostname.toLowerCase();
  if (EXAMPLE_HOSTNAMES.some((example) => hostname === example || hostname.endsWith(`.${example}`))) {
    throw new Error("SMILEID_PRIVACY_NOTICE_URL must name a real privacy notice, not an example URL");
  }
}

/** Validate real hybrid posture locally and in deployed environments before database work. */
export function validateIdentityRuntime(env: Env): void {
  const deployed = isDeployed(env);
  const localHybrid = !deployed && (env.FACE_VERIFIER === "hybrid" || env.FACE_VERIFIER === "smileid");
  if (!deployed && !localHybrid) return;
  if (deployed) {
    encryptionKeyBase64(env);
    sessionSecret(env);
  }
  const missing = [
    !env.IDENTITY_INTERNAL_TOKEN && "IDENTITY_INTERNAL_TOKEN",
    deployed && !env.DATABASE_URL && !env.HYPERDRIVE?.connectionString && "DATABASE_URL or HYPERDRIVE",
    !env.EDGE_URL && "EDGE_URL",
    !env.BIOMETRICS_SERVICE_URL && "BIOMETRICS_SERVICE_URL",
    !env.BIOMETRICS_SERVICE_TOKEN && "BIOMETRICS_SERVICE_TOKEN",
    !env.SMILEID_PARTNER_ID && "SMILEID_PARTNER_ID",
    !env.SMILEID_API_KEY && "SMILEID_API_KEY",
    deployed && !env.SMILEID_CALLBACK_URL && "SMILEID_CALLBACK_URL",
    !env.SMILEID_PRIVACY_NOTICE_URL && "SMILEID_PRIVACY_NOTICE_URL",
    !env.IDENTITY_CAPTURES && "IDENTITY_CAPTURES",
  ].filter((name): name is string => typeof name === "string");
  if (deployed && env.FACE_VERIFIER !== "hybrid") missing.unshift("FACE_VERIFIER=hybrid");
  const expectedVendorEnvironment = deployed && env.IDENTITY_ENV === "production" ? "production" : "sandbox";
  if (env.SMILEID_ENV !== expectedVendorEnvironment) missing.push(`SMILEID_ENV=${expectedVendorEnvironment}`);
  const scope = deployed ? "deployed" : "local hybrid";
  if (missing.length > 0) throw new Error(`${scope} identity configuration is incomplete: ${missing.join(", ")}`);

  if (localHybrid) {
    localServiceUrl(env.BIOMETRICS_SERVICE_URL!, "BIOMETRICS_SERVICE_URL");
    localServiceUrl(env.EDGE_URL!, "EDGE_URL");
    requireRealPrivacyNotice(nonLocalHttps(env.SMILEID_PRIVACY_NOTICE_URL!, "SMILEID_PRIVACY_NOTICE_URL", "local hybrid identity"));
    return;
  }

  nonLocalHttps(env.BIOMETRICS_SERVICE_URL!, "BIOMETRICS_SERVICE_URL");
  const edge = nonLocalHttps(env.EDGE_URL!, "EDGE_URL");
  const callback = nonLocalHttps(env.SMILEID_CALLBACK_URL!, "SMILEID_CALLBACK_URL");
  requireRealPrivacyNotice(nonLocalHttps(env.SMILEID_PRIVACY_NOTICE_URL!, "SMILEID_PRIVACY_NOTICE_URL"));
  if (callback.href !== new URL("/callbacks/smileid", edge).href) {
    throw new Error("SMILEID_CALLBACK_URL must be EDGE_URL/callbacks/smileid in deployed identity");
  }
}
