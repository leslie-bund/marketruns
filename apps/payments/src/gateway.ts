import type { PaymentBankView } from "@market-runs/proto";

/**
 * The collection-side gateway abstraction (ADR-0009): the ONLY seam through
 * which the payments worker verifies collected charges, executes buyer
 * refunds against a hold, lists payout banks, and resolves account names.
 * Vendor names appear ONLY in an implementation; everything upstream speaks
 * this interface. Money decisions are never made here — verification reports
 * provider truth, refunds execute amounts the settlement function already
 * decided (ADR-0007).
 */

/** Provider-truth facts about a collected charge, from the verify API. */
export interface ChargeVerification {
  /** Client-generated checkout reference (tx_ref). */
  txRef: string;
  /** Integration-layer transaction id (vendor-neutral providerTxId). */
  providerTxId: string;
  /** Charged amount, kobo (naira → kobo happens at the vendor boundary). */
  amountKobo: number;
  currency: string;
  /** Provider-reported payment method ("card", "bank_transfer", …) — drives the refund rail. */
  paymentMethod: string;
  /** Provider charge status, lowercased ("successful", "pending", "failed"). */
  status: string;
}

export interface ChargeRefundResult {
  /**
   * "processing" = the provider accepted the refund (card refunds settle in
   * days); "completed" = confirmed landed; "failed" = definitely rejected;
   * "indeterminate" = the request may have been accepted and must be reconciled.
   */
  status: "processing" | "completed" | "failed" | "indeterminate";
  providerRef?: string;
  failureReason?: string;
}

export type ChargeRefundReconciliationResult =
  | { status: "found"; refund: ChargeRefundResult & { status: "processing" | "completed"; providerRef: string } }
  | { status: "not-found" }
  | { status: "indeterminate" | "conflict"; failureReason: string };

export interface ChargeGateway {
  /** Verify a charge server-side by transaction id or txRef; null = unknown to the provider. */
  verifyCharge(query: { txRef?: string; transactionId?: string }): Promise<ChargeVerification | null>;
  /**
   * Refund against a collected charge. `amountKobo` null = full refund of the
   * original charge; a value = partial refund of exactly that many kobo.
   */
  refundCharge(providerTxId: string, amountKobo: number | null, comments: string): Promise<ChargeRefundResult>;
  /** Reconcile an ambiguous attempt against exact provider refund history before any new POST. */
  reconcileRefund(query: {
    providerTxId: string;
    amountKobo: number;
    comments: string;
  }): Promise<ChargeRefundReconciliationResult>;
  /**
   * Whether the provider's refund rail supports this payment method. Honest
   * by design: methods without an API rail (non-card collections; a bank
   * refund needs the buyer's account, which we don't hold) report false and
   * the refund is marked refund-manual for ops.
   */
  supportsRefund(paymentMethod: string): boolean;
  /** The provider's payout bank directory (NG). */
  listBanks(): Promise<PaymentBankView[]>;
  /** Resolve an account number to its account name; null = unresolvable. */
  resolveAccount(bankCode: string, accountNumber: string): Promise<{ accountName: string } | null>;
}

/**
 * Vendor-neutral charge-webhook classification (the vendor supplies the parse
 * implementation from its quarantine module). A `charge.completed` delivery is
 * a HINT — the worker always re-verifies with the gateway before placing a
 * hold; the webhook never proves money moved.
 */
export interface ChargeWebhookCharge {
  txRef: string | null;
  transactionId: string | null;
  /** Cart/buyer coordinates the client attached as charge meta at initiation. */
  cartId: string | null;
  buyerId: string | null;
}

export type ChargeWebhookParse =
  | { kind: "charge"; charge: ChargeWebhookCharge }
  | { kind: "ignored" }
  | { kind: "invalid" };
