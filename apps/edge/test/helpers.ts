import { env, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/env.js";
import { STATE_KEY } from "../src/do/state.js";
import type { MarketConfig } from "../src/do/schemas.js";
import { defaultMarketConfig } from "../src/do/schemas.js";
import { internalPost } from "../src/do/transport.js";

/** cloudflare:test env augmented with the edge bindings (see test/ambient.d.ts). */
export const bindings = env as unknown as Env;

export function marketStub(market: string) {
  return bindings.MARKET_DO.get(bindings.MARKET_DO.idFromName(market));
}
export function productStub(productId: string) {
  return bindings.PRODUCT_DO.get(bindings.PRODUCT_DO.idFromName(productId));
}
export function cartStub(cartId: string) {
  return bindings.CART_DO.get(bindings.CART_DO.idFromName(cartId));
}
export function runStub(runId: string) {
  return bindings.RUN_DO.get(bindings.RUN_DO.idFromName(runId));
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

export async function postIntent(intentId: string, market = "Balogun", buyerId?: string): Promise<Response> {
  return marketStub(market).fetch(
    internalPost("/intent", {
      type: "intent.posted",
      intentId,
      shopItem: "Tomatoes",
      quantity: 2,
      unit: "kg",
      priceBand: { minKobo: 120_000, maxKobo: 180_000 },
      note: "Firm, ripe tomatoes please",
      market,
      ...(buyerId !== undefined ? { buyerId } : {}),
    }),
  );
}

export async function offerProduct(
  productId: string,
  intentId: string,
  market = "Balogun",
  priceKobo = 165_000,
): Promise<Response> {
  return productStub(productId).fetch(
    internalPost("/offer", {
      productId,
      intentId,
      market,
      shopItem: "Tomatoes",
      quantity: 2,
      unit: "kg",
      priceKobo,
      sellerName: "Amina's Fresh Store",
      exchangePoint: `${market} Market, Stall B14`,
    }),
  );
}

/**
 * Accept a product directly at the ProductDO. `buyerId` rides the same
 * internal x-participant-id header command.ts sets from the auth seam —
 * it keys the buyer's cart (`cart:<market>:<buyerId>`).
 */
export async function acceptProduct(productId: string, buyerId?: string): Promise<Response> {
  return productStub(productId).fetch(
    internalPost(
      "/accept",
      { type: "product.accepted", productId },
      buyerId !== undefined ? new Headers({ "x-participant-id": buyerId }) : undefined,
    ),
  );
}

export async function checkout(
  cartId: string,
  delivery: { kind: "plus-code"; plusCode: string } | { kind: "muster-point"; name: string } = {
    kind: "plus-code",
    plusCode: "6FR5+8X Lagos",
  },
  buyerId?: string,
  /** Payment hold reference (txRef) for gated checkout (PAYMENTS_REQUIRED). */
  paymentRef?: string,
): Promise<Response> {
  return cartStub(cartId).fetch(
    internalPost("/checkout", {
      type: "checkout.requested",
      cartId,
      delivery,
      ...(buyerId !== undefined ? { buyerId } : {}),
      ...(paymentRef !== undefined ? { paymentRef } : {}),
    }),
  );
}

export async function setMarketConfig(market: string, overrides: Partial<MarketConfig>): Promise<Response> {
  const config: MarketConfig = { ...defaultMarketConfig(Date.now()), ...overrides };
  return marketStub(market).fetch(
    new Request("http://do/config", {
      method: "POST",
      headers: { "content-type": "application/json", "x-market-id": market },
      body: JSON.stringify(config),
    }),
  );
}

export { internalPost } from "../src/do/transport.js";
export { cartIdForBuyer, runIdForCart } from "../src/config/ids.js";

/**
 * The cart id a header-less (anonymous) test flow lands in: no caller header
 * and no intent buyerId ⇒ the anonymous fallback.
 */
export function anonymousCartId(market: string): string {
  return `cart:${market}:buyer:anonymous`;
}

/**
 * Deterministic-time seam for tests: shift the DO's clock by writing an
 * offset into its stored state. Production offset is always 0; the alarm
 * handlers themselves run for real via runDurableObjectAlarm.
 */
export async function shiftTime(stub: DurableObjectStub, offsetMs: number): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const current = (await state.storage.get<{ timeOffsetMs?: number }>(STATE_KEY)) ?? {};
    await state.storage.put(STATE_KEY, { ...current, timeOffsetMs: offsetMs });
  });
}
