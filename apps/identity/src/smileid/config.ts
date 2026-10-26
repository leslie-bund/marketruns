import type { Env } from "../env.js";

/**
 * Smile ID vendor configuration — read ONLY inside this quarantine
 * (ADR-0009). Keys come from the Smile ID Dashboard (Developer Settings),
 * are environment-specific (sandbox keys cannot call production), and live
 * in gitignored infra/.dev.vars locally / wrangler secrets in deploys.
 *
 * Verified against https://docs.usesmileid.com/api-reference/environments.md
 * (sandbox = testapi host; note this differs from older docs/SDKs that used
 * a *.smileidentity.com/v1 style base).
 */
export const SMILEID_BASE_URLS = {
  sandbox: "https://testapi.smileidentity.com",
  production: "https://api.smileidentity.com",
} as const;

export interface SmileIdConfig {
  partnerId: string;
  apiKey: string;
  environment: "sandbox" | "production";
  baseUrl: string;
  /** Per-request callback_url override; undefined → partner dashboard default. */
  callbackUrl?: string | undefined;
  /** HTTPS privacy notice URL forwarded in the consent record of every job. */
  privacyNoticeUrl: string;
}

/** DEV-ONLY placeholder consent notice — clearly labelled, overridden by env in any real deployment. */
export const DEV_PRIVACY_NOTICE_URL = "https://example.com/market-runs-dev-privacy-notice";

/**
 * Resolve config, or throw with an honest message when FACE_VERIFIER=smileid/hybrid
 * is selected without credentials — a silent fallback to the stub here would
 * be the fake-verify bug class ADR-0022 refuses to repeat.
 */
export function smileIdConfig(env: Env): SmileIdConfig {
  if (!env.SMILEID_PARTNER_ID || !env.SMILEID_API_KEY) {
    throw new Error(
      "FACE_VERIFIER=smileid/hybrid requires SMILEID_PARTNER_ID and SMILEID_API_KEY (Smile ID Dashboard → Developer Settings); no dev default exists — set them in infra/.dev.vars",
    );
  }
  const environment = env.SMILEID_ENV === "production" ? "production" : "sandbox";
  return {
    partnerId: env.SMILEID_PARTNER_ID,
    apiKey: env.SMILEID_API_KEY,
    environment,
    baseUrl: SMILEID_BASE_URLS[environment],
    callbackUrl: env.SMILEID_CALLBACK_URL || undefined,
    privacyNoticeUrl: env.SMILEID_PRIVACY_NOTICE_URL || DEV_PRIVACY_NOTICE_URL,
  };
}
