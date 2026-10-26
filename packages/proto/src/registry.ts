import { z } from "zod";
import { GeoPointValueSchema } from "./run.js";
import type { LocationFix } from "./primitives.js";

export const MarketGeofenceSchema = z.object({
  center: GeoPointValueSchema,
  radiusMeters: z.number().int().positive().default(750),
});
export type MarketGeofence = z.infer<typeof MarketGeofenceSchema>;

/** Durable Market registry projection. Times are local wall-clock HH:MM. */
export const MarketRegistryEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  opensAt: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  closesAt: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  /** Null/omitted means unconfigured: enforcement must fail closed, never invent a center. */
  geofence: MarketGeofenceSchema.optional(),
  /** Distinct connected sellers with an owned store and fresh in-perimeter fix. */
  onlineSellers: z.number().int().nonnegative(),
});
export type MarketRegistryEntry = z.infer<typeof MarketRegistryEntrySchema>;

export const MarketRegistryUpsertSchema = MarketRegistryEntrySchema.omit({ onlineSellers: true });
export type MarketRegistryUpsert = z.infer<typeof MarketRegistryUpsertSchema>;

export const MarketRegistryResponseSchema = z.object({ markets: z.array(MarketRegistryEntrySchema) });
export type MarketRegistryResponse = z.infer<typeof MarketRegistryResponseSchema>;

export const PRESENCE_TTL_MS = 60_000;

export interface SellerPresence {
  marketId: string;
  participantId: string;
  storeId: string;
  lastSeenAt: number;
  location: LocationFix;
}
