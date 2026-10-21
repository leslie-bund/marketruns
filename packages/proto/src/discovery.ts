import { z } from "zod";
import { IntentSchema } from "./intent.js";
import { ProductSchema } from "./negotiation.js";

/**
 * The filtered discovery read (GET /markets/:market/discovery): open intents
 * scoped to what the caller may see, with their live products inlined in the
 * same response — one round trip, no per-intent fan-out.
 *
 * Two scopes, combinable (both filters apply when both are given):
 * - `?shopItems=a,b` — the seller scope: intents whose shop item the caller's
 *   store supplies (the market vocabulary is the room, ADR-0006).
 * - `?buyerId=` / the forwarded participant identity header — the buyer scope:
 *   only the caller's own intents.
 *
 * A scope-less call returns nothing: discovery is deliberately the filtered
 * pathway (the unfiltered legacy read stays at GET /markets/:market/intents).
 */
export const IntentDiscoveryEntrySchema = z.object({
  intent: IntentSchema,
  /**
   * Live products offered against this intent, read fresh from their
   * ProductDOs at request time — statuses are current, and retired products
   * never appear (products are retired, never resurrected).
   */
  products: z.array(ProductSchema),
});
export type IntentDiscoveryEntry = z.infer<typeof IntentDiscoveryEntrySchema>;

export const DiscoveryResponseSchema = z.object({
  intents: z.array(IntentDiscoveryEntrySchema),
});
export type DiscoveryResponse = z.infer<typeof DiscoveryResponseSchema>;
