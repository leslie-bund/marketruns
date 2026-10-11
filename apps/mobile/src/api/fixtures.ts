import type { Cart, Intent, Negotiation, Product, Run, Store } from "./types";

const now = Date.now();

export const demoIntents: Intent[] = [
  { id: "intent-1", shopItem: "Tomatoes", quantity: 2, unit: "kg", priceBand: { minKobo: 120000, maxKobo: 180000 }, note: "Firm, ripe tomatoes please", market: "Balogun", createdAt: now - 12 * 60_000, status: "open" },
  { id: "intent-2", shopItem: "Red onions", quantity: 1, unit: "kg", priceBand: { minKobo: 70000, maxKobo: 100000 }, market: "Balogun", createdAt: now - 5 * 60_000, status: "open" },
];

export const demoProducts: Product[] = [
  { id: "product-1", intentId: "intent-1", shopItem: "Tomatoes", quantity: 2, unit: "kg", priceKobo: 165000, sellerName: "Amina's Fresh Store", exchangePoint: "Balogun Market, Stall B14", expiresAt: now + 17 * 60_000, status: "available" },
  { id: "product-2", intentId: "intent-2", shopItem: "Red onions", quantity: 1, unit: "kg", priceKobo: 85000, sellerName: "Tunde Provisions", exchangePoint: "Balogun Market, Stall A08", expiresAt: now + 24 * 60_000, status: "negotiating" },
];

export const demoNegotiations: Negotiation[] = [{ id: "negotiation-1", productId: "product-2", shopItem: "Red onions", otherParty: "Tunde Provisions", latestPriceKobo: 85000, messages: [{ by: "seller", text: "Fresh delivery this morning. ₦850", priceKobo: 85000, at: now - 3 * 60_000 }] }];
export const demoCart: Cart = { id: "cart-1", market: "Balogun", acceptanceCount: 2, firstAcceptedAt: now - 8 * 60_000, products: [{ ...demoProducts[0]!, status: "accepted" }, { ...demoProducts[1]!, status: "accepted" }] };
export const demoStores: Store[] = [{ id: "store-1", name: "Amina's Fresh Store", market: "Balogun", shopItems: ["Tomatoes", "Red onions", "Peppers"] }, { id: "store-2", name: "Tunde Provisions", market: "Balogun", shopItems: ["Red onions", "Rice", "Beans"] }];
export const demoRun: Run = { id: "run-1", market: "Balogun", floorRateKobo: 180000, delivery: { kind: "plus-code", plusCode: "6FR5+8X Lagos" }, stops: [{ sellerName: "Amina's Fresh Store", exchangePoint: "Balogun Market, Stall B14", shopItems: ["Tomatoes"], status: "next" }, { sellerName: "Tunde Provisions", exchangePoint: "Balogun Market, Stall A08", shopItems: ["Red onions"], status: "upcoming" }], handoffs: [{ id: "handoff-1", exchangePoint: "Balogun Market, Stall B14", counterparty: "Amina's Fresh Store", status: "pending", requestedAt: now - 40_000 }] };
