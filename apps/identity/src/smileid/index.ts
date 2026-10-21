/**
 * Smile ID vendor quarantine (ADR-0009): the ONLY module — besides the
 * FACE_VERIFIER selector in ../face-verifier.ts — where this vendor's name,
 * endpoints, auth scheme, and payload shapes appear. Domain code speaks in
 * enrollments, verifications, and jobs; it never speaks Smile ID.
 */
import type { Env } from "../env.js";
import { SmileIdClient, type FetchLike } from "./client.js";
import { smileIdConfig } from "./config.js";
import { SmileIdFaceVerifier } from "./verifier.js";

export { SmileIdApiError, SmileIdClient, type FetchLike } from "./client.js";
export { smileIdConfig, SMILEID_BASE_URLS, type SmileIdConfig } from "./config.js";
export { SmileIdFaceVerifier } from "./verifier.js";

export function createSmileIdFaceVerifier(env: Env, fetchImpl?: FetchLike): SmileIdFaceVerifier {
  return new SmileIdFaceVerifier(new SmileIdClient(smileIdConfig(env), fetchImpl));
}
