import { demoCart, demoIntents, demoNegotiations, demoProducts, demoRun, demoStores } from "./fixtures";
import type { Cart, Intent, Negotiation, Product, Role, Run, Store } from "./types";

/** Typed API seam; these fixture-backed methods will map to the Worker API when available. */
export const api = {
  getIntents(_role: Role): Intent[] { return demoIntents; },
  getProducts(): Product[] { return demoProducts; },
  getNegotiations(): Negotiation[] { return demoNegotiations; },
  getCart(): Cart { return demoCart; },
  getStores(): Store[] { return demoStores; },
  getRun(): Run { return demoRun; },
  async createIntent(input: Pick<Intent, "shopItem" | "quantity" | "priceBand" | "note">): Promise<Intent> { return { ...demoIntents[0]!, ...input, id: `intent-${Date.now()}`, market: "Balogun", unit: "items", createdAt: Date.now(), status: "open" }; },
  async createProduct(input: Pick<Product, "intentId" | "shopItem" | "quantity" | "unit" | "priceKobo">): Promise<Product> { return { ...demoProducts[0]!, ...input, id: `product-${Date.now()}`, sellerName: demoStores[0]!.name, exchangePoint: "Balogun Market", expiresAt: Date.now() + 30 * 60_000, status: "available" }; },
  async adjustNegotiationPrice(_id: string, priceKobo: number): Promise<number> { return priceKobo; },
  async checkout(_destination: Run["delivery"]): Promise<Run> { return demoRun; },
  async confirmHandoff(_id: string): Promise<void> {},
};
