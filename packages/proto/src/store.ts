import { z } from "zod";
import { TimestampSchema } from "./primitives.js";

/**
 * A Store is a seller's virtual storefront registered to one market
 * (GLOSSARY.md). Its shop items are the store's persistent catalog and feed
 * the market's item vocabulary, which grows from what sellers actually
 * register (ADR-0006) — the vocabulary is what scopes intents to stores.
 */
export const StoreSchema = z.object({
  id: z.string().min(1),
  market: z.string().min(1),
  name: z.string().min(1),
  exchangePoint: z.string().min(1),
  /** The store's persistent catalog: what this store can supply. */
  shopItems: z.array(z.string().min(1)).min(1),
  joinedAt: TimestampSchema,
});
export type Store = z.infer<typeof StoreSchema>;

/** Seller → edge: register a store when joining a market. `storeId` is the idempotency key. */
export const StoreRegisteredSchema = z.object({
  type: z.literal("store.registered"),
  storeId: z.string().min(1),
  market: z.string().min(1),
  name: z.string().min(1),
  exchangePoint: z.string().min(1),
  shopItems: z.array(z.string().min(1)).min(1),
});
export type StoreRegistered = z.infer<typeof StoreRegisteredSchema>;

/** Edge → market: the store is registered; the vocabulary may have grown. */
export const StoreRecordedSchema = z.object({
  type: z.literal("store.recorded"),
  store: StoreSchema,
});
export type StoreRecorded = z.infer<typeof StoreRecordedSchema>;
