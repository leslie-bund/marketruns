/**
 * Flutterwave integration configuration — vendor quarantine (ADR-0009).
 * The vendor name and its env keys may appear ONLY inside
 * apps/payments/src/flutterwave/ and the dispatcher selector
 * (apps/payments/src/dispatcher.ts).
 *
 * Secrets never commit: local dev reads them from infra/.dev.vars (gitignored;
 * see infra/.dev.vars.example), deploys use `wrangler secret put`.
 */

export interface FlutterwaveEnv {
  /** Secret key (FLWSECK_TEST-… or FLWSECK-…). Test keys work against the same production host. */
  FLUTTERWAVE_SECRET_KEY?: string;
  /** Secret hash configured in the dashboard's webhook settings; echoed back in the `verif-hash` header. */
  FLUTTERWAVE_WEBHOOK_SECRET_HASH?: string;
  /** API base URL. v3 test and live keys both talk to https://api.flutterwave.com. */
  FLUTTERWAVE_BASE_URL?: string;
  /** Optional per-transfer callback_url passed at transfer creation (webhooks are the primary channel). */
  FLUTTERWAVE_CALLBACK_URL?: string;
  /** Dev-stage payout recipient map (JSON); see recipients.ts in this folder. */
  DEV_PAYOUT_RECIPIENTS?: string;
  /**
   * Test-mode transfer accelerator (LOCAL DEV ONLY — never set in production):
   * truthy appends the provider's magic success suffix to every outgoing
   * transfer reference so mock transfers settle in ~1 min instead of 10
   * (see dispatcher.ts in this folder).
   */
  FLUTTERWAVE_TEST_MODE?: string;
}

export interface FlutterwaveConfig {
  secretKey: string;
  webhookSecretHash: string | null;
  baseUrl: string;
  callbackUrl: string | null;
  /** TRUE only in local dev against test keys: outgoing references carry the mock success suffix. */
  testMode: boolean;
}

export const FLUTTERWAVE_DEFAULT_BASE_URL = "https://api.flutterwave.com";

/** Read and validate the vendor config; throws loudly when the secret key is missing. */
export function flutterwaveConfig(env: FlutterwaveEnv): FlutterwaveConfig {
  const secretKey = env.FLUTTERWAVE_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error(
      'PAYMENT_DISPATCHER=flutterwave requires FLUTTERWAVE_SECRET_KEY — ' +
        "drop a FLWSECK_TEST-… key into infra/.dev.vars (see infra/.dev.vars.example) or `wrangler secret put` it",
    );
  }
  const webhookSecretHash = env.FLUTTERWAVE_WEBHOOK_SECRET_HASH?.trim() ?? "";
  const callbackUrl = env.FLUTTERWAVE_CALLBACK_URL?.trim() ?? "";
  const baseUrl = (env.FLUTTERWAVE_BASE_URL?.trim() || FLUTTERWAVE_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const testModeRaw = env.FLUTTERWAVE_TEST_MODE?.trim();
  const testMode = testModeRaw !== undefined && testModeRaw !== "" && testModeRaw !== "0" && testModeRaw.toLowerCase() !== "false";
  if (testMode && !secretKey.startsWith("FLWSECK_TEST-")) {
    throw new Error("FLUTTERWAVE_TEST_MODE requires an FLWSECK_TEST- secret key; the test accelerator is forbidden with live keys");
  }
  return {
    secretKey,
    webhookSecretHash: webhookSecretHash === "" ? null : webhookSecretHash,
    baseUrl,
    callbackUrl: callbackUrl === "" ? null : callbackUrl,
    testMode,
  };
}
