import { z } from "zod";
import {
  HandoffInitiatedSchema,
  IntentSchema,
  KoboSchema,
  ProductRetirementReasonSchema,
  ProductSchema,
  TimestampSchema,
} from "@market-runs/proto";

/**
 * Internal DO-to-DO request/response shapes. Every field type is borrowed
 * from @market-runs/proto schemas — these are routing payloads, not a
 * parallel client wire.
 */

/** Per-market operational config: close gate, trip estimate, floor-rate and settlement coefficients. */
export const MarketConfigSchema = z.object({
  /** Next market close, epoch ms. Checkout requires close − now > estTrip + buffer. */
  closeAt: TimestampSchema,
  estTripMs: z.number().int().nonnegative(),
  bufferMs: z.number().int().nonnegative(),
  /** Floor Rate inputs (domain floorRate); real distance/duration come from routing at checkout. */
  floorRate: z.object({
    distanceMeters: z.number().nonnegative(),
    estimatedDurationMs: z.number().nonnegative(),
    baseKobo: KoboSchema,
    perKilometerKobo: KoboSchema,
    perMinuteKobo: KoboSchema,
  }),
  settlement: z.object({
    goodsCommissionBps: z.number().int().min(0).max(10_000),
    deliveryMarginKobo: KoboSchema,
  }),
});
export type MarketConfig = z.infer<typeof MarketConfigSchema>;

/** A sensible default so a market works before ops configures it. Values are tunable per market. */
export function defaultMarketConfig(now: number): MarketConfig {
  return {
    closeAt: now + 8 * 60 * 60 * 1000,
    estTripMs: 20 * 60 * 1000,
    bufferMs: 5 * 60 * 1000,
    floorRate: {
      distanceMeters: 3_000,
      estimatedDurationMs: 20 * 60 * 1000,
      baseKobo: 100_000,
      perKilometerKobo: 20_000,
      perMinuteKobo: 500,
    },
    settlement: { goodsCommissionBps: 1_000, deliveryMarginKobo: 10_000 },
  };
}

export const CloseGateResponseSchema = z.object({
  ok: z.boolean(),
  refusal: z.string().nullable(),
  closeAt: z.number(),
  now: z.number(),
  estTripMs: z.number(),
  bufferMs: z.number(),
});
export type CloseGateResponse = z.infer<typeof CloseGateResponseSchema>;

export const IntentLookupResponseSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    intent: IntentSchema,
    /** The intent's TTL deadline in the MarketDO. */
    expiresAt: TimestampSchema,
  }),
]);
export type IntentLookupResponse = z.infer<typeof IntentLookupResponseSchema>;

/** A seller's offer of a Product in response to an Intent (store route → ProductDO /offer). */
export const OfferProductRequestSchema = ProductSchema.pick({
  shopItem: true,
  quantity: true,
  unit: true,
  priceKobo: true,
  sellerName: true,
  exchangePoint: true,
}).extend({
  productId: z.string().min(1),
  intentId: z.string().min(1),
  /** The offering store's market; determines which MarketDO holds the intent. */
  market: z.string().min(1),
});
export type OfferProductRequest = z.infer<typeof OfferProductRequestSchema>;

/** ProductDO → CartDO after a successful accept. */
export const CartAppendRequestSchema = z.object({
  cartId: z.string().min(1),
  market: z.string().min(1),
  product: ProductSchema,
});
export type CartAppendRequest = z.infer<typeof CartAppendRequestSchema>;

export const RetireProductRequestSchema = z.object({
  reason: ProductRetirementReasonSchema,
});
export type RetireProductRequest = z.infer<typeof RetireProductRequestSchema>;

export const InitiateHandoffRequestSchema = HandoffInitiatedSchema.pick({
  handoffId: true,
  exchangePointId: true,
  counterparty: true,
});
export type InitiateHandoffRequest = z.infer<typeof InitiateHandoffRequestSchema>;

export const HandoffRefRequestSchema = z.object({
  handoffId: z.string().min(1),
});
export type HandoffRefRequest = z.infer<typeof HandoffRefRequestSchema>;

/** CartDO → RunDO at checkout: the Run projection plus its settlement legs and coefficients. */
export const SeedRunRequestSchema = z.object({
  run: z.object({
    id: z.string().min(1),
    market: z.string().min(1),
    status: z.enum(["assigned", "collecting", "delivering", "delivered", "closed", "aborted"]),
    floorRateKobo: KoboSchema,
    delivery: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("plus-code"), plusCode: z.string().min(1) }),
      z.object({ kind: z.literal("muster-point"), name: z.string().min(1) }),
    ]),
    stops: z.array(z.object({
      sellerName: z.string().min(1),
      exchangePoint: z.string().min(1),
      shopItems: z.array(z.string().min(1)),
      status: z.enum(["next", "upcoming", "completed"]),
    })),
  }),
  legs: z.array(z.object({ sellerId: z.string().min(1), amountKobo: KoboSchema })).min(1),
  settlement: z.object({
    goodsCommissionBps: z.number().int().min(0).max(10_000),
    deliveryMarginKobo: KoboSchema,
  }),
});
export type SeedRunRequest = z.infer<typeof SeedRunRequestSchema>;

export const DisputeRunRequestSchema = z.object({
  reason: z.string().min(1),
});
export type DisputeRunRequest = z.infer<typeof DisputeRunRequestSchema>;

/**
 * Deterministic id derivation. One open cart per market until participant
 * identity lands on the wire (the wire commands carry no buyer id — a proto
 * gap reported to the human); the run is 1:1 with its cart.
 */
export function cartIdForMarket(market: string): string {
  return `cart:${market}`;
}

export function runIdForCart(cartId: string): string {
  return `run:${cartId}`;
}

/** Build a POST request addressed to a DO's internal route. */
export function internalPost(path: string, body: unknown, headers?: Headers): Request {
  const allHeaders = new Headers(headers);
  allHeaders.set("content-type", "application/json");
  return new Request(`http://do${path}`, {
    method: "POST",
    headers: allHeaders,
    body: JSON.stringify(body),
  });
}

/** Fetch an internal endpoint and parse the JSON response with a zod schema. */
export async function fetchInternal<S extends z.ZodTypeAny>(
  stub: DurableObjectStub,
  request: Request,
  schema: S,
): Promise<z.infer<S> | Response> {
  const response = await stub.fetch(request);
  if (!response.ok) return response;
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return new Response("internal endpoint returned non-JSON", { status: 502 });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "bad-internal-response", issues: parsed.error.issues }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
  return parsed.data;
}
