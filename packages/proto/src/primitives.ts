import { z } from "zod";

/**
 * Primitive wire types shared by every message family.
 *
 * All money in the system is integer kobo (1/100 ₦). Floats and negatives are
 * wire errors, full stop — the settlement function refuses them too.
 */
export const KoboSchema = z.number().int().nonnegative();
export type Kobo = z.infer<typeof KoboSchema>;

/** Epoch milliseconds. */
export const TimestampSchema = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof TimestampSchema>;

export const QuantitySchema = z.number().int().positive();
export type Quantity = z.infer<typeof QuantitySchema>;

export const RoleSchema = z.enum(["Buyer", "Seller", "Runner"]);
export type Role = z.infer<typeof RoleSchema>;

/** The buyer's stated price expectation on an Intent; guides, never caps. */
export const PriceBandSchema = z
  .object({ minKobo: KoboSchema, maxKobo: KoboSchema })
  .refine((band) => band.minKobo <= band.maxKobo, {
    message: "priceBand.minKobo must be <= priceBand.maxKobo",
  });
export type PriceBand = z.infer<typeof PriceBandSchema>;

/** Where the Run ends: the buyer's own plus-code, or a partner-operated Muster Point. */
export const DeliverySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plus-code"), plusCode: z.string().min(1) }),
  z.object({ kind: z.literal("muster-point"), name: z.string().min(1) }),
]);
export type Delivery = z.infer<typeof DeliverySchema>;

/** Throttled fire-and-forget location stream; confirmations are must-arrive. */
export const GeoLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  observedAt: TimestampSchema,
});
export type GeoLocation = z.infer<typeof GeoLocationSchema>;
