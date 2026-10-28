import type {
  PaymentBankView,
  PaymentChargeConfirmResponse,
  PayoutAccountResolveResponse,
  PayoutAccountView,
} from "@market-runs/proto";
import { EDGE_URL, identities } from "./config";
import { ApiError } from "./client";
import { getActiveParticipant, participantHeaders } from "./participant";
import { clearSession, sessionHeaders } from "./auth";

/**
 * Payments client — the app side of the payments worker's collection/payout
 * surface, reached through the edge's /payments/* proxy (same one-base-URL
 * posture as /auth/*; client traffic stays edge-first). Raw fetch like
 * auth.ts: this module sits beside client.ts and shares its ApiError and
 * header patterns (session Bearer + participant headers ride every call).
 *
 * Wire contracts (proto/payments.ts):
 * - POST /payments/charges/confirm — confirm a completed checkout charge and
 *   place the hold. Idempotent on txRef; 409 amount-mismatch /
 *   charge-not-successful / currency-mismatch / hold-conflict, 404
 *   charge-not-found. The worker verifies with the provider server-side —
 *   expectedAmountKobo is a cross-check, never trusted.
 * - GET  /payments/banks — the provider's NG bank directory.
 * - POST /payments/payout-accounts/resolve — account number → account name
 *   (422 account-unresolvable; never stores anything).
 * - POST /payments/payout-accounts — save (always provider-resolved first).
 *   GET/DELETE /payments/payout-accounts/:participantId — read / revoke.
 */

async function paymentsRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const authorization = sessionHeaders();
  const response = await fetch(`${EDGE_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...authorization, ...participantHeaders(), ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401 && authorization.authorization) void clearSession();
    throw new ApiError(response.status, String(body.error ?? "unknown"), String(body.message ?? response.statusText));
  }
  return body as T;
}

/** The caller's wire identity: the onboarded participant, else the demo buyer. */
function callerId(): string {
  return getActiveParticipant()?.id ?? identities.buyer.id;
}

/** Checkout reference: mr:<cartId-tail>:<rand> — client-generated, idempotency key of the hold. */
export function newTxRef(cartId: string): string {
  const tail = cartId.slice(-8);
  const rand = Math.random().toString(36).slice(2, 8);
  return `mr:${tail}:${rand}`;
}

/**
 * Confirm a completed checkout charge (Flutterwave callback) and place the
 * hold the checkout gate reads. Retry-safe: idempotent on txRef, so a
 * confirm-after-crash replays cleanly.
 */
export async function confirmCharge(input: {
  txRef?: string;
  transactionId?: string | number;
  expectedAmountKobo: number;
  cartId: string;
  buyerId?: string;
}): Promise<PaymentChargeConfirmResponse> {
  return paymentsRequest<PaymentChargeConfirmResponse>("/payments/charges/confirm", {
    method: "POST",
    body: JSON.stringify({
      ...(input.txRef ? { txRef: input.txRef } : {}),
      ...(input.transactionId !== undefined ? { transactionId: input.transactionId } : {}),
      expectedAmountKobo: input.expectedAmountKobo,
      buyerId: input.buyerId ?? callerId(),
      cartId: input.cartId,
    }),
  });
}

/** The provider's NG bank directory for the payout-account picker. */
export async function listBanks(): Promise<PaymentBankView[]> {
  const body = await paymentsRequest<{ items: PaymentBankView[] }>("/payments/banks");
  return body.items;
}

/** Resolve an account number to its account name — never stores anything. */
export async function resolvePayoutAccount(bankCode: string, accountNumber: string): Promise<PayoutAccountResolveResponse> {
  return paymentsRequest<PayoutAccountResolveResponse>("/payments/payout-accounts/resolve", {
    method: "POST",
    body: JSON.stringify({ bankCode, accountNumber }),
  });
}

/**
 * Save the participant's payout account. The server re-resolves with the
 * provider before storing — an unresolved account is never stored (422).
 */
export async function savePayoutAccount(input: {
  participantId: string;
  bankCode: string;
  accountNumber: string;
}): Promise<PayoutAccountView> {
  return paymentsRequest<PayoutAccountView>("/payments/payout-accounts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** The participant's active payout account; null when none is saved (404). */
export async function getPayoutAccount(participantId: string): Promise<PayoutAccountView | null> {
  try {
    return await paymentsRequest<PayoutAccountView>(`/payments/payout-accounts/${encodeURIComponent(participantId)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Revoke the participant's payout account (the "change" path revokes, then re-adds). */
export async function revokePayoutAccount(participantId: string): Promise<void> {
  await paymentsRequest<PayoutAccountView>(`/payments/payout-accounts/${encodeURIComponent(participantId)}`, {
    method: "DELETE",
  });
}

/** Mask an account number for display: ••0031. */
export function maskAccountNumber(accountNumber: string): string {
  return `••${accountNumber.slice(-4)}`;
}
