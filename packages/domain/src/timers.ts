export type Clock = () => number;

export const INTENT_TTL_MS = 30 * 60 * 1000;
export const PRODUCT_TTL_MS = 30 * 60 * 1000;
export const CART_FIRST_ACCEPTANCE_MS = 30 * 60 * 1000;
export const CART_ADDITIONAL_ACCEPTANCE_MS = 10 * 60 * 1000;
export const CART_MAX_DURATION_MS = 60 * 60 * 1000;
export const HANDOFF_AUTO_CONFIRM_MS = 3 * 60 * 1000;
export const DISPUTE_WINDOW_MS = 30 * 60 * 1000;

export function cartDeadline(firstAcceptedAt: number, acceptanceCount: number): number {
  if (!Number.isInteger(acceptanceCount) || acceptanceCount < 1) {
    throw new RangeError("acceptanceCount must be a positive integer");
  }
  return Math.min(
    firstAcceptedAt + CART_FIRST_ACCEPTANCE_MS + (acceptanceCount - 1) * CART_ADDITIONAL_ACCEPTANCE_MS,
    firstAcceptedAt + CART_MAX_DURATION_MS,
  );
}

export function productTtl(createdAt: number, intentExpiresAt: number): number {
  return Math.min(createdAt + PRODUCT_TTL_MS, intentExpiresAt);
}

export function marketCloseGateOk(
  now: number,
  closeTime: number,
  estTripMs: number,
  bufferMs: number,
): boolean {
  return closeTime - now > estTripMs + bufferMs;
}
