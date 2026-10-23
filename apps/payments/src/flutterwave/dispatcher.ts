import { z } from "zod";
import type {
  DispatchTransferRequest,
  DispatchTransferResult,
  PaymentDispatcher,
  TransferStatusLookup,
} from "../dispatcher.js";
import { RECIPIENT_UNRESOLVED, type RecipientResolver } from "../recipients.js";
import type { FlutterwaveConfig } from "./config.js";

/**
 * Flutterwave Transfers v3 dispatcher (vendor quarantine — ADR-0009).
 *
 * API shape (developer.flutterwave.com, v3 reference, verified against the
 * current docs):
 *   POST {base}/v3/transfers
 *     Authorization: Bearer <secret key>   (test keys hit the same host)
 *     { account_bank, account_number, amount (NAIRA, decimal), currency:
 *       "NGN", narration, reference, callback_url?, debit_currency: "NGN" }
 *   → envelope { status: "success", data: { id, status, reference, … } }
 *   GET {base}/v3/transfers/:id            — poll one transfer
 *   GET {base}/v3/transfers?reference=<r>  — look a transfer up by our reference
 *
 * Status mapping (honest — acceptance is not settlement):
 *   provider NEW        → queued    (accepted, not yet on the rails)
 *   provider PENDING    → sent      (in-flight; completion unconfirmed)
 *   provider SUCCESSFUL → completed (settled at the destination account)
 *   provider FAILED     → failed    (complete_message carries the reason)
 *
 * Idempotency: our per-leg idempotencyKey is sent as the transfer `reference`;
 * the provider rejects duplicates ("Payout with this ref already exists"), and
 * we then resolve the ORIGINAL transfer by reference and report its real
 * status — provider-level retries collapse instead of double-paying.
 *
 * Test-mode transfer accelerator (LOCAL DEV ONLY, `FLUTTERWAVE_TEST_MODE`):
 * mock transfers sit PENDING ~10 min by default; a reference ending
 * `_PMCKDU_1` forces SUCCESSFUL in ~1 min (provider-documented). Under test
 * mode we append that suffix to the outgoing reference and strip it from
 * every reference that comes BACK (webhook parse, duplicate-collapse lookup)
 * so dispatch rows still match on the bare idempotencyKey. NEVER enable in
 * production. The provider also documents a failure variant (`_PMCK_ST_FDU_1`)
 * for failure drills — deliberately NOT wired here; drills append it manually.
 *
 * Amounts: kobo → naira happens HERE and nowhere upstream (the provider takes
 * decimal naira). Payout rails limits (Flutterwave support docs, NGN bank
 * payouts): minimum ₦100, maximum ₦1,000,000 per transfer — legs outside the
 * band fail honestly (visible in ops, replayable) instead of being silently
 * clamped, because clamping would be a money decision (ADR-0007 forbids).
 */

const KOBO_PER_NAIRA = 100;
/** ₦100 — Flutterwave's documented minimum NGN bank payout. */
export const MIN_PAYOUT_KOBO = 100 * KOBO_PER_NAIRA;
/** ₦1,000,000 — Flutterwave's documented per-transfer NGN bank payout cap. */
export const MAX_PAYOUT_KOBO = 1_000_000 * KOBO_PER_NAIRA;

/** The provider's mock-mode success accelerator suffix (test mode only — see the module header). */
export const TEST_MODE_SUCCESS_SUFFIX = "_PMCKDU_1";

/** The provider's mock-mode failure suffix — for MANUAL failure drills only; never sent by this dispatcher. */
export const TEST_MODE_FAILURE_SUFFIX = "_PMCK_ST_FDU_1";

/** The reference sent to the provider: the bare idempotency key, suffixed only under test mode. */
export function outboundReference(idempotencyKey: string, testMode: boolean): string {
  return testMode ? `${idempotencyKey}${TEST_MODE_SUCCESS_SUFFIX}` : idempotencyKey;
}

/** Map an inbound provider reference back to our idempotency key (strips the test-mode suffix, test mode only). */
export function inboundReference(reference: string, testMode: boolean): string {
  return testMode && reference.endsWith(TEST_MODE_SUCCESS_SUFFIX)
    ? reference.slice(0, -TEST_MODE_SUCCESS_SUFFIX.length)
    : reference;
}

/** providerRef prefix: `flw:<numeric transfer id>` (cf. the stub's `stub:<sha>`). */
export const PROVIDER_REF_PREFIX = "flw:";

const TransferDataSchema = z.object({
  id: z.union([z.number(), z.string()]),
  status: z.string().optional(),
  reference: z.string().optional(),
  complete_message: z.string().nullable().optional(),
});

const EnvelopeSchema = z.object({
  status: z.string(),
  message: z.string().optional(),
  data: z.unknown().nullable().optional(),
});

const TransferListEnvelopeSchema = z.object({
  status: z.string(),
  message: z.string().optional(),
  data: z.array(z.unknown()).nullable().optional(),
});

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Map a provider transfer object onto our dispatch status vocabulary. */
export function mapProviderTransfer(data: {
  id: number | string;
  status?: string | undefined;
  complete_message?: string | null | undefined;
}): DispatchTransferResult {
  const providerRef = `${PROVIDER_REF_PREFIX}${String(data.id)}`;
  switch ((data.status ?? "").toUpperCase()) {
    case "SUCCESSFUL":
      return { status: "completed", providerRef };
    case "FAILED":
      return {
        status: "failed",
        providerRef,
        failureReason: data.complete_message?.trim() || "provider reported the transfer failed",
        // A provider-terminal FAILED is not something a queue retry can undo.
        retryable: false,
      };
    case "PENDING":
      return { status: "sent", providerRef };
    case "NEW":
      return { status: "queued", providerRef };
    default:
      // An unrecognized provider state after a successful create means the
      // transfer was accepted but its state is unknown — treat as queued and
      // let webhook/sync converge it rather than guessing terminal.
      return { status: "queued", providerRef };
  }
}

export class FlutterwaveDispatcher implements PaymentDispatcher, TransferStatusLookup {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: FlutterwaveConfig,
    private readonly recipients: RecipientResolver,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async dispatchTransfer(request: DispatchTransferRequest): Promise<DispatchTransferResult> {
    const recipient = await this.recipients.resolve(request.recipient.partyId, request.recipient.account);
    if (!recipient) {
      // A missing payout target is a configuration gap, not a transient error.
      return { status: "failed", failureReason: RECIPIENT_UNRESOLVED, retryable: false };
    }
    if (request.amountKobo < MIN_PAYOUT_KOBO) {
      return {
        status: "failed",
        failureReason: `below-provider-minimum: NGN bank payouts start at ₦${MIN_PAYOUT_KOBO / KOBO_PER_NAIRA}`,
        retryable: false,
      };
    }
    if (request.amountKobo > MAX_PAYOUT_KOBO) {
      return {
        status: "failed",
        failureReason: `above-provider-maximum: single NGN bank payouts cap at ₦${MAX_PAYOUT_KOBO / KOBO_PER_NAIRA}`,
        retryable: false,
      };
    }

    // The provider-side reference: bare idempotency key, or suffixed with the
    // mock success accelerator under FLUTTERWAVE_TEST_MODE (never production).
    const reference = outboundReference(request.idempotencyKey, this.config.testMode);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/v3/transfers`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.secretKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          account_bank: recipient.accountBank,
          account_number: recipient.accountNumber,
          // Kobo → naira at the vendor boundary ONLY; kobo is integer, so the
          // division is exact to 2dp for every value the settlement emits.
          amount: request.amountKobo / KOBO_PER_NAIRA,
          currency: "NGN",
          debit_currency: "NGN",
          narration: request.memo,
          reference,
          ...(recipient.accountName !== undefined ? { beneficiary_name: recipient.accountName } : {}),
          ...(this.config.callbackUrl !== null ? { callback_url: this.config.callbackUrl } : {}),
        }),
      });
    } catch (error) {
      // Network failure: the transfer MAY have been created. Safe to report
      // failed and retry — the duplicate-reference path below collapses the
      // retry onto the original transfer.
      return { status: "failed", failureReason: `provider-unreachable: ${String(error)}`, retryable: true };
    }

    const envelope = await readJson(response);
    const parsed = EnvelopeSchema.safeParse(envelope);
    if (!parsed.success) {
      // A 2xx with an unreadable body may still have created the transfer;
      // retrying is safe because the duplicate-reference path collapses it.
      return {
        status: "failed",
        failureReason: `provider-response-unparseable: HTTP ${response.status}`,
        retryable: response.status < 400 || retryableHttpStatus(response.status),
      };
    }

    if (parsed.data.status !== "success") {
      const message = parsed.data.message ?? `HTTP ${response.status}`;
      if (isDuplicateReference(message)) {
        // Our idempotency key already lives at the provider: resolve the
        // original transfer and report ITS status — never a second payout.
        // Provider-side lookups use the same (possibly suffixed) reference
        // the original transfer was created with.
        const original = await this.lookupByReference(reference);
        if (original) return original;
        // The original may not be visible yet (eventual consistency); retry
        // so the next duplicate response can collapse onto it.
        return {
          status: "failed",
          failureReason: `duplicate-reference-unresolved: ${message}`,
          retryable: true,
        };
      }
      // 4xx validation is deterministic; 429/5xx can recover. A 2xx error
      // envelope is a provider-side rejection, so do not spin the queue.
      return { status: "failed", failureReason: message, retryable: retryableHttpStatus(response.status) };
    }

    const transfer = TransferDataSchema.safeParse(parsed.data.data);
    if (!transfer.success) {
      // The create succeeded but the body is incomplete; a retry is safe
      // (duplicate-collapse) and may return the original transfer.
      return { status: "failed", failureReason: "provider-response-missing-transfer", retryable: true };
    }
    return mapProviderTransfer(transfer.data);
  }

  /** Poll one accepted transfer by providerRef (`flw:<id>`); null = unknown to the provider. */
  async fetchTransferStatus(providerRef: string): Promise<DispatchTransferResult | null> {
    if (!providerRef.startsWith(PROVIDER_REF_PREFIX)) return null;
    const id = providerRef.slice(PROVIDER_REF_PREFIX.length);
    if (id === "") return null;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/v3/transfers/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${this.config.secretKey}` },
      });
    } catch {
      return null;
    }
    const parsed = EnvelopeSchema.safeParse(await readJson(response));
    if (!parsed.success || parsed.data.status !== "success") return null;
    const transfer = TransferDataSchema.safeParse(parsed.data.data);
    return transfer.success ? mapProviderTransfer(transfer.data) : null;
  }

  /** Find the original transfer carrying our reference (duplicate-collapse path). */
  private async lookupByReference(reference: string): Promise<DispatchTransferResult | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.config.baseUrl}/v3/transfers?reference=${encodeURIComponent(reference)}`,
        { headers: { authorization: `Bearer ${this.config.secretKey}` } },
      );
    } catch {
      return null;
    }
    const parsed = TransferListEnvelopeSchema.safeParse(await readJson(response));
    if (!parsed.success || parsed.data.status !== "success") return null;
    const first = parsed.data.data?.[0];
    const transfer = TransferDataSchema.safeParse(first);
    return transfer.success ? mapProviderTransfer(transfer.data) : null;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isDuplicateReference(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("already exists") || lower.includes("duplicate");
}

/** Provider throttling and server faults may clear on retry; 4xx validation cannot. */
function retryableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}
