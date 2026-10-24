/**
 * Provider-facing reference aliases.
 *
 * The local per-leg idempotency key remains the canonical, durable identity
 * (`settlement:<settlementRecordId>:leg:<n>`). Some providers cap their
 * transfer `reference` field well below the length of that key, so the vendor
 * boundary sends a deterministic short alias instead and persists the mapping
 * on the dispatch row (ADR-0024 amendment).
 *
 * Alias shape: `mr_` + the first 48 hex characters of a domain-separated
 * SHA-256 (192 bits). That is 51 characters, leaving room for the Flutterwave
 * test-mode suffix (9 characters) inside the provider's 64-character cap.
 *
 * The hash input includes the full leg key, including the leg index: hashing
 * only the settlement record would make every leg share one provider reference
 * and collapse distinct payouts. The alias is deterministic, so queue
 * redelivery, worker restarts, and ops replays reuse the same provider-side
 * idempotency key. It is not reversible; inbound webhook/reconcile matching
 * uses the persisted `payment_dispatches.provider_reference` column.
 */

/** Prefix identifying an alias issued by this system. */
export const PROVIDER_REFERENCE_PREFIX = "mr_";

/** Hex characters retained from SHA-256 (48 × 4 = 192 bits). */
export const PROVIDER_REFERENCE_HASH_HEX_LENGTH = 48;

/** Provider reference ceiling (Flutterwave Transfers v3); the alias must fit under it. */
export const MAX_PROVIDER_REFERENCE_LENGTH = 64;

/** Domain separation, so this hash cannot be confused with another use of SHA-256. */
const PROVIDER_REFERENCE_DOMAIN = "market-runs:provider-reference:v1:";

/**
 * Derive the deterministic provider-facing reference for one local payout leg.
 *
 * Callers persist this before the first send (the consumer does), so a webhook
 * that races ahead of the HTTP response can still find the row by alias.
 */
export async function providerReferenceFor(idempotencyKey: string): Promise<string> {
  if (idempotencyKey.length === 0) {
    throw new Error("providerReferenceFor: idempotencyKey must not be empty");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${PROVIDER_REFERENCE_DOMAIN}${idempotencyKey}`),
  );
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const reference = `${PROVIDER_REFERENCE_PREFIX}${hex.slice(0, PROVIDER_REFERENCE_HASH_HEX_LENGTH)}`;
  if (reference.length > MAX_PROVIDER_REFERENCE_LENGTH) {
    throw new Error(`providerReferenceFor: generated reference is ${reference.length} characters (max 64)`);
  }
  return reference;
}
