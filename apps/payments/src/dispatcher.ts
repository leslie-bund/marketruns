import type { DispatchAccount } from "@market-runs/proto";
import type { ChargeGateway, ChargeWebhookParse } from "./gateway.js";
import type { PayoutAccountStore } from "./payout-accounts.js";
import { createVendorIntegration } from "./flutterwave/index.js";

/**
 * The payment dispatch abstraction (ADR-0009): the ONLY seam through which
 * settlement payout legs leave the platform for a payment service provider.
 *
 * Doctrine: the settlement function already decided every kobo
 * (ADR-0007/0008) — a dispatcher executes transfers, it never decides
 * amounts, recipients, or splits. Vendor names appear ONLY inside a
 * PaymentDispatcher implementation; the interface and everything upstream
 * of it are vendor-neutral.
 */

export interface DispatchTransferRequest {
  /** Canonical per-leg idempotency key (`settlement:<recordId>:leg:<n>`), persisted and used for local replay. */
  idempotencyKey: string;
  /**
   * Provider-facing reference alias persisted on the row (ADR-0024 amendment).
   * Vendors with a reference-length cap send this instead of the full key.
   * Omitted for legacy rows; the vendor derives the same deterministic alias
   * from idempotencyKey.
   */
  providerReference?: string;
  recipient: { partyId: string; account: DispatchAccount };
  amountKobo: number;
  memo: string;
}

export interface DispatchTransferResult {
  /**
   * "queued" = accepted by the provider, not yet on the payout rails;
   * "sent" = in-flight on the rails, completion unconfirmed;
   * "completed" = confirmed settled at the destination (terminal);
   * "failed" = not moved / terminally rejected (replayable).
   */
  status: "sent" | "queued" | "failed" | "completed";
  /** Vendor-neutral transfer reference for reconciliation; required unless failed. */
  providerRef?: string;
  /** The provider-facing reference alias actually sent; persisted for webhook/reconcile matching. */
  providerReference?: string;
  failureReason?: string;
  /**
   * Only meaningful when status is "failed". `true` (the default when omitted)
   * means a queue retry may succeed — network/5xx/ambiguous outcomes. `false`
   * means a deterministic rejection (unknown recipient, provider validation,
   * amount outside limits): retrying the same request cannot change it, so the
   * consumer stops retrying, keeps the hold blocked, and leaves the row for an
   * operator replay after the cause is fixed.
   */
  retryable?: boolean;
}

export interface PaymentDispatcher {
  dispatchTransfer(request: DispatchTransferRequest): Promise<DispatchTransferResult>;
}

/**
 * Optional dispatcher capability: poll the provider for the current state of
 * a previously accepted transfer. Powers POST /dispatches/sync (and is the
 * fallback when a webhook never arrives). Returns null when the providerRef
 * is unknown to the provider.
 */
export interface TransferStatusLookup {
  fetchTransferStatus(providerRef: string): Promise<DispatchTransferResult | null>;
}

export function isTransferStatusLookup(dispatcher: PaymentDispatcher): dispatcher is PaymentDispatcher & TransferStatusLookup {
  return typeof (dispatcher as Partial<TransferStatusLookup>).fetchTransferStatus === "function";
}

/**
 * Vendor-neutral webhook plumbing (the vendor supplies the implementations
 * from its quarantine module; the HTTP route in index.ts stays generic).
 */
export interface TransferWebhookOutcome {
  /** Provider-facing reference alias, echoed back as the transfer reference. */
  reference: string | null;
  /** Full providerRef for fallback row matching when no reference is carried. */
  providerRef: string | null;
  status: "completed" | "failed";
  completeMessage: string | null;
}

export type TransferWebhookParse =
  | { kind: "outcome"; outcome: TransferWebhookOutcome }
  | { kind: "ignored" }
  | { kind: "invalid" };

export interface TransferWebhookHooks {
  /** Header the provider stamps on webhook deliveries (e.g. a shared-secret hash header). */
  hashHeader: string;
  /** Constant-time check of the presented header against the configured secret. */
  verify(secret: string, presented: string | null): Promise<boolean>;
  /** Classify a delivery: terminal transfer outcome, ignorable, or malformed. */
  parse(body: unknown): TransferWebhookParse;
  /**
   * Optional second family: classify a delivery as a completed-charge hint.
   * Tried when `parse` ignores the body; the hold layer re-verifies with the
   * provider before placing a hold (webhooks are hints, verify API is truth).
   */
  parseCharge?(body: unknown): ChargeWebhookParse;
}

/**
 * Dev-stage dispatcher: records nothing external, always succeeds, and
 * returns a deterministic fake reference (`stub:<sha256>`) derived from the
 * idempotency key + recipient + amount, so replays produce identical
 * references and tests can assert determinism. It reports "sent" — executed
 * synchronously with nothing further to track.
 */
export class StubDispatcher implements PaymentDispatcher {
  async dispatchTransfer(request: DispatchTransferRequest): Promise<DispatchTransferResult> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `${request.idempotencyKey}:${request.recipient.account}:${request.recipient.partyId}:${request.amountKobo}`,
      ),
    );
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return { status: "sent", providerRef: `stub:${hex.slice(0, 24)}` };
  }
}

/** A dispatcher plus any vendor integration extras (webhook verification config, collection gateway). */
export interface DispatchIntegration {
  dispatcher: PaymentDispatcher;
  /**
   * Transfer-outcome webhook support; absent = the vendor pushes nothing and
   * POST /webhooks/transfers 503s. `secret: null` = webhook deliveries are
   * expected but not yet configured (also 503, loudly).
   */
  webhook?: { secret: string | null; hooks: TransferWebhookHooks };
  /**
   * Collection-side gateway (charge verification, refunds, bank directory,
   * account resolution). Absent under the stub dispatcher — the hold/refund/
   * payout-account HTTP routes then answer 503 collection-unavailable.
   */
  gateway?: ChargeGateway;
}

/**
 * Resolve the configured dispatch integration; "stub" is the default.
 * The "flutterwave" selector string is part of the dispatcher module — the
 * only other place the vendor name may appear is its quarantine folder
 * (apps/payments/src/flutterwave/, ADR-0009).
 */
export function resolveDispatchIntegration(
  env: { PAYMENT_DISPATCHER?: string },
  deps: { payoutAccounts?: PayoutAccountStore } = {},
): DispatchIntegration {
  const kind = env.PAYMENT_DISPATCHER ?? "stub";
  if (kind === "stub") return { dispatcher: new StubDispatcher() };
  if (kind === "flutterwave") {
    // The vendor env keys (secret key, webhook hash, …) are defined and
    // validated inside the quarantine module.
    return createVendorIntegration(env as unknown as Parameters<typeof createVendorIntegration>[0], deps);
  }
  throw new Error(`unknown PAYMENT_DISPATCHER "${kind}" — known kinds: "stub" (dev default), "flutterwave"`);
}

/** Resolve just the dispatcher (queue consumer path). */
export function resolveDispatcher(env: { PAYMENT_DISPATCHER?: string }): PaymentDispatcher {
  return resolveDispatchIntegration(env).dispatcher;
}
