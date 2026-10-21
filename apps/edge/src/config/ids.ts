/**
 * Deterministic id derivation. One open cart per buyer per market:
 * `cart:<market>:<buyerId>`, keyed by the participant identity resolved at
 * the auth seam (ADR-0015). The run stays 1:1 with its cart, so runs are
 * per-buyer automatically.
 *
 * The edge is authoritative for this contract: clients learn their cart id
 * from the accept response (`cart.updated.cart.id`) or from
 * `GET /markets/:market/cart` with their identity headers — they should
 * never derive it themselves.
 */
export function cartIdForBuyer(market: string, buyerId: string): string {
  return `cart:${market}:${buyerId}`;
}

export function runIdForCart(cartId: string): string {
  return `run:${cartId}`;
}
