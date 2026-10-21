import { z } from "zod";
import { KoboSchema, QuantitySchema, TimestampSchema } from "./primitives.js";

/**
 * A Product is a seller's ephemeral offer in response to an Intent. It exists
 * only until accepted, expired, or withdrawn; it is accepted exactly once and
 * retired, never resurrected (GLOSSARY.md).
 */
export const ProductStatusSchema = z.enum([
  "available",
  "negotiating",
  "accepted",
  "withdrawn",
  "expired",
  "retired",
]);
export type ProductStatus = z.infer<typeof ProductStatusSchema>;

/** One price move in a Negotiation thread: who moved, to what, when. */
export const PriceMoveSchema = z.object({
  by: z.enum(["buyer", "seller"]),
  priceKobo: KoboSchema,
  at: TimestampSchema,
});
export type PriceMove = z.infer<typeof PriceMoveSchema>;

export const ProductSchema = z.object({
  id: z.string().min(1),
  intentId: z.string().min(1),
  shopItem: z.string().min(1),
  quantity: QuantitySchema,
  unit: z.string().min(1),
  priceKobo: KoboSchema,
  sellerName: z.string().min(1),
  exchangePoint: z.string().min(1),
  expiresAt: TimestampSchema,
  status: ProductStatusSchema,
  /** Camera-only capture at offer time; the signed R2 reference, never bytes. */
  photoCaptureRef: z.string().min(1).optional(),
});
export type Product = z.infer<typeof ProductSchema>;

/** Edge → buyer: a Seller responded to the buyer's Intent with an offer. */
export const ProductOfferedSchema = z.object({
  type: z.literal("product.offered"),
  product: ProductSchema,
  /**
   * The negotiation thread so far (initial offer plus every adjustment).
   * Carried on the ProductDO read response so clients can render history;
   * absent on the bare broadcast.
   */
  priceHistory: z.array(PriceMoveSchema).optional(),
});
export type ProductOffered = z.infer<typeof ProductOfferedSchema>;

/** Edge → buyer: the Seller released the Product without sale. */
export const ProductWithdrawnSchema = z.object({
  type: z.literal("product.withdrawn"),
  productId: z.string().min(1),
  withdrawnAt: TimestampSchema,
});
export type ProductWithdrawn = z.infer<typeof ProductWithdrawnSchema>;

/**
 * Price adjustment inside the one-to-one Negotiation over a Product. Either
 * side may adjust (ADR-0002); the buyer's Price Band guides but never caps.
 */
export const NegotiationPriceAdjustedSchema = z.object({
  type: z.literal("negotiation.price-adjusted"),
  productId: z.string().min(1),
  by: z.enum(["buyer", "seller"]),
  priceKobo: KoboSchema,
  at: TimestampSchema,
});
export type NegotiationPriceAdjusted = z.infer<typeof NegotiationPriceAdjustedSchema>;
