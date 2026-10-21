import { z } from "zod";
import type { PaymentBankView } from "@market-runs/proto";
import type { ChargeGateway, ChargeRefundResult, ChargeVerification } from "../gateway.js";
import type { FlutterwaveConfig } from "./config.js";

/**
 * Flutterwave collection-side gateway (vendor quarantine — ADR-0009):
 * charge verification, refunds against a collected charge, the NG bank
 * directory, and account-name resolution.
 *
 * API shape (developer.flutterwave.com, v3 reference):
 *   GET  {base}/v3/transactions/:id/verify                 — verify by transaction id
 *   GET  {base}/v3/transactions/verify_by_reference?tx_ref — verify by our tx_ref
 *   POST {base}/v3/transactions/:id/refund                 — refund; `amount` (naira) = partial, omitted = full
 *   GET  {base}/v3/banks/NG                                — transfer bank directory
 *   POST {base}/v3/accounts/resolve                        — account-name enquiry { account_bank, account_number }
 *   envelope: { status: "success"|"error", message, data }
 *
 * Pinned facts:
 *   - Verify response data carries { id, tx_ref, status, amount (NAIRA,
 *     decimal), currency, payment_type }. Amounts convert naira → kobo HERE
 *     and nowhere upstream.
 *   - The refund endpoint targets CARD transactions; card refunds complete in
 *     3–15 days (status stays "processing" on initiation). Non-card methods
 *     (bank_transfer, ussd) have no API rail — supportsRefund() reports false
 *     and the worker marks the refund refund-manual rather than faking it.
 *   - Account resolve is NG-only; an unresolvable account returns null, never
 *     a guessed name.
 */

const KOBO_PER_NAIRA = 100;

/** providerRef prefix for refunds: `flw-refund:<refund id>` (cf. transfers' `flw:<id>`). */
export const REFUND_PROVIDER_REF_PREFIX = "flw-refund:";

const EnvelopeSchema = z.object({
  status: z.string(),
  message: z.string().optional(),
  data: z.unknown().nullable().optional(),
});

const VerifyDataSchema = z.object({
  id: z.union([z.number(), z.string()]),
  tx_ref: z.string().optional(),
  status: z.string().optional(),
  amount: z.union([z.number(), z.string()]).optional(),
  currency: z.string().optional(),
  payment_type: z.string().optional(),
});

const RefundDataSchema = z.object({
  id: z.union([z.number(), z.string()]),
  status: z.string().optional(),
});

const BanksDataSchema = z.array(
  z.object({
    code: z.union([z.number(), z.string()]),
    name: z.string(),
  }),
);

const ResolveDataSchema = z.object({
  account_number: z.string().optional(),
  account_name: z.string().optional(),
});

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class FlutterwaveGateway implements ChargeGateway {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: FlutterwaveConfig,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Verify a charge server-side; null when the provider doesn't know it (or is unreachable). */
  async verifyCharge(query: { txRef?: string; transactionId?: string }): Promise<ChargeVerification | null> {
    const url =
      query.transactionId !== undefined
        ? `${this.config.baseUrl}/v3/transactions/${encodeURIComponent(query.transactionId)}/verify`
        : query.txRef !== undefined
          ? `${this.config.baseUrl}/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(query.txRef)}`
          : null;
    if (url === null) return null;
    const parsed = await this.get(url);
    if (!parsed || parsed.status !== "success") return null;
    const data = VerifyDataSchema.safeParse(parsed.data);
    if (!data.success) return null;
    const amount = Number(data.data.amount);
    if (!Number.isFinite(amount)) return null;
    return {
      txRef: data.data.tx_ref ?? query.txRef ?? "",
      providerTxId: String(data.data.id),
      // Naira → kobo at the vendor boundary ONLY; round to defend against
      // provider decimal noise (e.g. 1650.0000001).
      amountKobo: Math.round(amount * KOBO_PER_NAIRA),
      currency: data.data.currency ?? "",
      paymentMethod: data.data.payment_type ?? "unknown",
      status: (data.data.status ?? "").toLowerCase(),
    };
  }

  /** Refund a card charge; amountKobo null = full refund. */
  async refundCharge(providerTxId: string, amountKobo: number | null, comments: string): Promise<ChargeRefundResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.config.baseUrl}/v3/transactions/${encodeURIComponent(providerTxId)}/refund`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.secretKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            // Kobo → naira at the vendor boundary ONLY. Omitting `amount` is
            // the provider's full-refund semantics — never send a rounded
            // partial when the whole charge goes back.
            ...(amountKobo !== null ? { amount: amountKobo / KOBO_PER_NAIRA } : {}),
            comments,
          }),
        },
      );
    } catch (error) {
      // Network failure: the refund MAY have been initiated. Retrying is safe
      // for a FULL refund (provider dedupes per transaction); partial-refund
      // retries risk double-refunding, so the caller's replay path must check
      // provider state first — recorded honestly as failed here.
      return { status: "failed", failureReason: `provider-unreachable: ${String(error)}` };
    }
    const parsed = EnvelopeSchema.safeParse(await readJson(response));
    if (!parsed.success) {
      return { status: "failed", failureReason: `provider-response-unparseable: HTTP ${response.status}` };
    }
    if (parsed.data.status !== "success") {
      return { status: "failed", failureReason: parsed.data.message ?? `HTTP ${response.status}` };
    }
    const data = RefundDataSchema.safeParse(parsed.data.data);
    if (!data.success) {
      return { status: "failed", failureReason: "provider-response-missing-refund" };
    }
    return { status: "processing", providerRef: `${REFUND_PROVIDER_REF_PREFIX}${String(data.data.id)}` };
  }

  /** The refund rail targets card charges; every other method is an ops-manual refund. */
  supportsRefund(paymentMethod: string): boolean {
    return paymentMethod === "card";
  }

  /** The NG transfer bank directory (the HTTP layer caches with a TTL). */
  async listBanks(): Promise<PaymentBankView[]> {
    const parsed = await this.get(`${this.config.baseUrl}/v3/banks/NG`);
    if (!parsed || parsed.status !== "success") {
      throw new Error(`bank directory fetch failed: ${parsed?.message ?? "provider unreachable"}`);
    }
    const banks = BanksDataSchema.safeParse(parsed.data);
    if (!banks.success) throw new Error("bank directory response failed validation");
    return banks.data.map((bank) => ({ code: String(bank.code), name: bank.name }));
  }

  /** Account-name enquiry; null when the account cannot be resolved. */
  async resolveAccount(bankCode: string, accountNumber: string): Promise<{ accountName: string } | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/v3/accounts/resolve`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.secretKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ account_bank: bankCode, account_number: accountNumber }),
      });
    } catch {
      return null;
    }
    const parsed = EnvelopeSchema.safeParse(await readJson(response));
    if (!parsed.success || parsed.data.status !== "success") return null;
    const data = ResolveDataSchema.safeParse(parsed.data.data);
    const name = data.success ? data.data.account_name?.trim() : undefined;
    return name ? { accountName: name } : null;
  }

  private async get(url: string): Promise<z.infer<typeof EnvelopeSchema> | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${this.config.secretKey}` },
      });
    } catch {
      return null;
    }
    const parsed = EnvelopeSchema.safeParse(await readJson(response));
    return parsed.success ? parsed.data : null;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
