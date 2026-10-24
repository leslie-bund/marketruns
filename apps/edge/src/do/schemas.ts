import { z } from "zod";
import {
  GeoPointValueSchema,
  HandoffInitiatedSchema,
  IntentSchema,
  KoboSchema,
  ProductRetirementReasonSchema,
  ProductSchema,
  RunRouteSchema,
  TimestampSchema,
} from "@market-runs/proto";

/**
 * Internal DO-to-DO request/response shapes. Every field type is borrowed
 * from @market-runs/proto schemas — these are routing payloads, not a
 * parallel client wire.
 */

/** A named place in the market with coordinates — routing resolves names to these. */
export const GeoPointSchema = z.object({
  name: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof GeoPointSchema>;

/** Per-market operational config: close gate, trip estimate, floor-rate and settlement coefficients. */
export const MarketConfigSchema = z.object({
  /** Next market close, epoch ms. Checkout requires close − now > estTrip + buffer. */
  closeAt: TimestampSchema,
  /**
   * Dev-stage rollover marker (ADR-0013): true once ops has written the
   * config — an ops-set close is deliberate and never rolls forward. Absent/
   * false means auto-generated; an expired auto-generated closeAt lazily
   * rolls forward by MARKET_OPEN_WINDOW_MS when next evaluated (MarketDO.config()).
   */
  opsConfigured: z.boolean().optional(),
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
  /**
   * Market geography for routing at checkout: the center is the runner's
   * start and the reference for short Plus Codes; exchange/muster points
   * resolve stop and delivery names to coordinates. Optional so configs
   * written before routing landed keep parsing — routing falls back to the
   * static floor-rate inputs when it is absent.
   */
  geo: z
    .object({
      center: GeoPointSchema.omit({ name: true }),
      exchangePoints: z.array(GeoPointSchema),
      musterPoints: z.array(GeoPointSchema),
    })
    .optional(),
});
export type MarketConfig = z.infer<typeof MarketConfigSchema>;

/**
 * The default market open window (ADR-0013 dev stage): an auto-generated
 * config closes 8h after creation, and an expired one lazily rolls forward
 * by this same window so a dev/stage market never expires permanently.
 */
export const MARKET_OPEN_WINDOW_MS = 8 * 60 * 60 * 1000;

/** A sensible default so a market works before ops configures it. Values are tunable per market. */
export function defaultMarketConfig(now: number): MarketConfig {
  return {
    closeAt: now + MARKET_OPEN_WINDOW_MS,
    opsConfigured: false,
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
    // Balogun Market, Lagos Island — demo geography until ops configures the
    // real exchange points. All within a few hundred metres of the market.
    geo: {
      center: { latitude: 6.4541, longitude: 3.3947 },
      exchangePoints: [
        { name: "Balogun Market, Stall B14", latitude: 6.4544, longitude: 3.3949 },
        { name: "Balogun Market, Stall A02", latitude: 6.4536, longitude: 3.394 },
        { name: "Balogun Market, Stall C21", latitude: 6.4548, longitude: 3.3941 },
      ],
      musterPoints: [
        { name: "Balogun Market Partner", latitude: 6.4556, longitude: 3.3962 },
      ],
    },
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

/** ProductDO → MarketDO at offer time: index the product under its intent. */
export const IntentProductRequestSchema = z.object({
  intentId: z.string().min(1),
  productId: z.string().min(1),
});
export type IntentProductRequest = z.infer<typeof IntentProductRequestSchema>;

/** A shop-item vocabulary string (ADR-0006): a trimmed display name, 1–64 chars. */
export const VocabularyItemSchema = z.string().trim().min(1).max(64);

/**
 * Ops console → MarketDO vocabulary moderation (ADR-0006: the platform
 * curates normalization and synonyms, not a canon). `remove` drops the item
 * from every store's shop items; `rename` rewrites it in place — the
 * normalization lever. Matching inside the DO is case-insensitive, the same
 * semantics as the /intents scope filter.
 */
export const ModerateVocabularyRequestSchema = z
  .discriminatedUnion("action", [
    z.object({ action: z.literal("remove"), item: VocabularyItemSchema }),
    z.object({ action: z.literal("rename"), from: VocabularyItemSchema, to: VocabularyItemSchema }),
  ])
  .refine((data) => data.action !== "rename" || data.from !== data.to, {
    message: "rename from and to must differ",
    path: ["to"],
  });
export type ModerateVocabularyRequest = z.infer<typeof ModerateVocabularyRequestSchema>;

/** MarketDO → ops console: the post-action vocabulary plus every store the action touched. */
export const ModerateVocabularyResponseSchema = z.object({
  vocabulary: z.array(z.string()),
  affectedStores: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type ModerateVocabularyResponse = z.infer<typeof ModerateVocabularyResponseSchema>;

/** MarketDO → buyers: the live discovery index for an intent. */
export const IntentProductsResponseSchema = z.object({
  productIds: z.array(z.string().min(1)),
});
export type IntentProductsResponse = z.infer<typeof IntentProductsResponseSchema>;

/** A seller's offer of a Product in response to an Intent (store route → ProductDO /offer). */
export const OfferProductRequestSchema = ProductSchema.pick({
  shopItem: true,
  quantity: true,
  unit: true,
  priceKobo: true,
  sellerName: true,
  exchangePoint: true,
  photoCaptureRef: true,
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
  /** The accepting buyer's identity (resolved at the auth seam, ADR-0015) — the cart's owner. */
  buyerId: z.string().min(1),
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
      legDistanceMeters: z.number().nonnegative().optional(),
      legDurationSeconds: z.number().nonnegative().optional(),
      location: GeoPointValueSchema.optional(),
    })),
    /** Routed trip path + totals when OSRM was reachable at checkout; absent otherwise. */
    route: RunRouteSchema.optional(),
  }),
  legs: z.array(z.object({ sellerId: z.string().min(1), amountKobo: KoboSchema })).min(1),
  settlement: z.object({
    goodsCommissionBps: z.number().int().min(0).max(10_000),
    deliveryMarginKobo: KoboSchema,
  }),
  /** Durable identities carried from checkout through to the archive records. */
  buyerId: z.string().min(1),
  runnerId: z.string().min(1),
  sellerParticipantIds: z.array(z.string().min(1)).optional(),
});
export type SeedRunRequest = z.infer<typeof SeedRunRequestSchema>;

export const DisputeRunRequestSchema = z.object({
  reason: z.string().min(1),
  /** The disputing participant, adopted from the identity headers at the edge route (ADR-0015). */
  raisedByParticipantId: z.string().min(1).optional(),
  /**
   * Evidence the raiser attaches (ADR-0007: disputes resolve evidence-first).
   * The RunDO merges these with every handoff photo reference the run holds.
   */
  evidenceRefs: z.array(z.string().min(1)).optional(),
});
export type DisputeRunRequest = z.infer<typeof DisputeRunRequestSchema>;

/**
 * Ops console → RunDO settle-only adjustment (ADR-0013). The adjustment is
 * expressed entirely as settlement-function inputs; `reason` is human context
 * echoed in the response, not a side channel.
 */
export const OpsSettleRequestSchema = z.object({
  mode: z.enum(["completed", "aborted", "disputed"]),
  /** Disputed mode: whether the evidence was ambiguous (loss absorbed, capped). */
  ambiguous: z.boolean().optional(),
  requestedPlatformLossKobo: KoboSchema.optional(),
  reason: z.string().min(1).optional(),
});
export type OpsSettleRequest = z.infer<typeof OpsSettleRequestSchema>;
