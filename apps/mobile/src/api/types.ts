export type Role = "Buyer" | "Seller" | "Runner";
export type Intent = { id: string; shopItem: string; quantity: number; unit: string; priceBand: { minKobo: number; maxKobo: number }; note?: string; market: string; createdAt: number; status: "open" | "matched" };
export type Product = { id: string; intentId: string; shopItem: string; quantity: number; unit: string; priceKobo: number; sellerName: string; exchangePoint: string; expiresAt: number; status: "available" | "negotiating" | "accepted" };
export type Negotiation = { id: string; productId: string; shopItem: string; otherParty: string; latestPriceKobo: number; messages: { by: "buyer" | "seller"; text: string; priceKobo?: number; at: number }[] };
export type Cart = { id: string; market: string; acceptanceCount: number; firstAcceptedAt: number; products: Product[] };
export type Store = { id: string; name: string; market: string; shopItems: string[] };
export type Handoff = { id: string; exchangePoint: string; counterparty: string; status: "pending" | "confirmed"; requestedAt: number };
export type Run = { id: string; market: string; floorRateKobo: number; delivery: { kind: "plus-code"; plusCode: string } | { kind: "muster-point"; name: string }; stops: { sellerName: string; exchangePoint: string; shopItems: string[]; status: "next" | "upcoming" }[]; handoffs: Handoff[] };
