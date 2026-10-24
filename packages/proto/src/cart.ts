import { z } from "zod";
import { DeliverySchema, KoboSchema, TimestampSchema } from "./primitives.js";
import { ProductSchema } from "./negotiation.js";

/**
 * The Cart's single shared lap-timer deadline (ADR-0003): 30 min from the
 * first acceptance, +10 min per additional acceptance, 60-min hard ceiling.
 * On expiry the whole Cart retires atomically — products are never
 * resurrected piecemeal.
 */
export const CartStatusSchema = z.enum(["open", "checked-out", "retired"]);
export type CartStatus = z.infer<typeof CartStatusSchema>;

export const CartSchema = z.object({
  id: z.string().min(1),
  market: z.string().min(1),
  products: z.array(ProductSchema),
  firstAcceptedAt: TimestampSchema,
  acceptanceCount: z.number().int().nonnegative(),
  deadline: TimestampSchema,
  status: CartStatusSchema,
  /** Edge-resolved cart owner; optional only for legacy anonymous carts. */
  buyerId: z.string().min(1).optional(),
});
export type Cart = z.infer<typeof CartSchema>;

/** Buyer → edge: accept a Product into the Cart. Accept-once is enforced by the ProductDO. */
export const ProductAcceptedSchema = z.object({
  type: z.literal("product.accepted"),
  productId: z.string().min(1),
});
export type ProductAccepted = z.infer<typeof ProductAcceptedSchema>;

/** Edge → buyer: Cart state after any acceptance, extension, or retirement. */
export const CartUpdatedSchema = z.object({
  type: z.literal("cart.updated"),
  cart: CartSchema,
});
export type CartUpdated = z.infer<typeof CartUpdatedSchema>;

/** Buyer → edge: lock the Cart and commit to delivery. */
export const CheckoutRequestedSchema = z.object({
  type: z.literal("checkout.requested"),
  cartId: z.string().min(1),
  delivery: DeliverySchema,
  /**
   * Buyer identity, client-supplied until participant auth lands on the wire
   * (documented proto gap). Absent → the run is anchored to "buyer:anonymous"
   * and reputation/ledger attribution is limited accordingly.
   */
  buyerId: z.string().min(1).optional(),
  /**
   * Payment hold reference (the checkout charge's txRef), required when the
   * edge runs with PAYMENTS_REQUIRED on: checkout is gated on a verified hold
   * covering the checkout total. Absent → unpaid dev checkout (dev default).
   */
  paymentRef: z.string().min(1).optional(),
});
export type CheckoutRequested = z.infer<typeof CheckoutRequestedSchema>;

/**
 * Edge → buyer: checkout accepted at the Floor Rate (MVP: internal runners at
 * floor rate only, ADR-0013). The Run takes over from here.
 */
export const CheckoutAcceptedSchema = z.object({
  type: z.literal("checkout.accepted"),
  cartId: z.string().min(1),
  runId: z.string().min(1),
  floorRateKobo: KoboSchema,
  delivery: DeliverySchema,
  buyerId: z.string().min(1).optional(),
  runnerId: z.string().min(1).optional(),
});
export type CheckoutAccepted = z.infer<typeof CheckoutAcceptedSchema>;
