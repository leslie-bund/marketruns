import { z } from "zod";

/** CRUD-ready durable Market registry projection. Times are local wall-clock HH:MM. */
export const MarketRegistryEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  opensAt: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  closesAt: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  /** Distinct authenticated sellers with a registered store and fresh foreground heartbeat. */
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
}
