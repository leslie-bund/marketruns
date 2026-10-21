/**
 * Vendor quarantine barrel (ADR-0009): the ONLY module outside this folder
 * that may reference the vendor is apps/payments/src/dispatcher.ts (the
 * PAYMENT_DISPATCHER selector). The HTTP surface consumes the vendor-neutral
 * DispatchIntegration/TransferWebhookHooks contract — it never imports this
 * folder. Everything upstream speaks PaymentDispatcher / DispatchStore only.
 */
import type { DispatchIntegration, PaymentDispatcher, TransferStatusLookup } from "../dispatcher.js";
import type { ChargeGateway } from "../gateway.js";
import type { PayoutAccountStore } from "../payout-accounts.js";
import { DbRecipientResolver } from "../payout-accounts.js";
import { ChainRecipientResolver, type RecipientResolver } from "../recipients.js";
import { FLUTTERWAVE_DEFAULT_BASE_URL, flutterwaveConfig, type FlutterwaveConfig, type FlutterwaveEnv } from "./config.js";
import { DevRecipientResolver } from "./recipients.js";
import { FlutterwaveGateway, REFUND_PROVIDER_REF_PREFIX } from "./gateway.js";
import {
  FlutterwaveDispatcher,
  MAX_PAYOUT_KOBO,
  MIN_PAYOUT_KOBO,
  PROVIDER_REF_PREFIX,
  TEST_MODE_FAILURE_SUFFIX,
  TEST_MODE_SUCCESS_SUFFIX,
  inboundReference,
  mapProviderTransfer,
  outboundReference,
} from "./dispatcher.js";
import {
  WEBHOOK_HASH_HEADER,
  parseChargeWebhook,
  parseTransferWebhook,
  verifyWebhookHash,
  type ChargeWebhookParse,
  type TransferWebhookOutcome,
  type TransferWebhookParse,
} from "./webhook.js";

export {
  FLUTTERWAVE_DEFAULT_BASE_URL,
  flutterwaveConfig,
  type FlutterwaveConfig,
  type FlutterwaveEnv,
  DevRecipientResolver,
  FlutterwaveDispatcher,
  FlutterwaveGateway,
  MAX_PAYOUT_KOBO,
  MIN_PAYOUT_KOBO,
  PROVIDER_REF_PREFIX,
  REFUND_PROVIDER_REF_PREFIX,
  TEST_MODE_FAILURE_SUFFIX,
  TEST_MODE_SUCCESS_SUFFIX,
  inboundReference,
  mapProviderTransfer,
  outboundReference,
  WEBHOOK_HASH_HEADER,
  parseChargeWebhook,
  parseTransferWebhook,
  verifyWebhookHash,
  type ChargeWebhookParse,
  type TransferWebhookOutcome,
  type TransferWebhookParse,
};

/**
 * Build the full vendor integration from worker env. Throws loudly when the
 * secret key is missing — a payments worker that cannot sign requests must
 * fail fast, not silently fall back.
 *
 * Recipient resolution is DB-first when a payout-account store is provided
 * (saved, provider-resolved accounts), falling back to the dev env map and
 * documented test accounts (DevRecipientResolver). Unknown parties still fail
 * honestly as recipient-unresolved.
 */
export function createVendorIntegration(
  env: FlutterwaveEnv,
  deps: { payoutAccounts?: PayoutAccountStore } = {},
): DispatchIntegration {
  const config = flutterwaveConfig(env);
  const resolvers: RecipientResolver[] = [];
  if (deps.payoutAccounts) resolvers.push(new DbRecipientResolver(deps.payoutAccounts));
  resolvers.push(new DevRecipientResolver(env.DEV_PAYOUT_RECIPIENTS));
  const dispatcher: PaymentDispatcher & TransferStatusLookup = new FlutterwaveDispatcher(
    config,
    new ChainRecipientResolver(resolvers),
  );
  const gateway: ChargeGateway = new FlutterwaveGateway(config);
  return {
    dispatcher,
    gateway,
    webhook: {
      secret: config.webhookSecretHash,
      hooks: {
        hashHeader: WEBHOOK_HASH_HEADER,
        verify: verifyWebhookHash,
        // Test mode (FLUTTERWAVE_TEST_MODE, dev only): outgoing references
        // carry the mock success suffix, so an echoed webhook reference must
        // be stripped back to the bare idempotency key before row matching.
        parse: (body: unknown): TransferWebhookParse => {
          const parsed = parseTransferWebhook(body);
          if (parsed.kind === "outcome" && parsed.outcome.reference !== null) {
            parsed.outcome.reference = inboundReference(parsed.outcome.reference, config.testMode);
          }
          return parsed;
        },
        parseCharge: parseChargeWebhook,
      },
    },
  };
}
