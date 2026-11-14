import { z } from "zod";
import { AdminRunSummarySchema } from "./admin.js";
import { CartRetirementReasonSchema } from "./archive.js";
import { ProductSchema } from "./negotiation.js";
import { KoboSchema, QuantitySchema, TimestampSchema } from "./primitives.js";

export const CartHistoryEntrySchema = z.object({
  id: z.string().min(1),
  cartId: z.string().min(1),
  market: z.string().min(1),
  reason: CartRetirementReasonSchema,
  products: z.array(ProductSchema),
  firstAcceptedAt: TimestampSchema,
  deadline: TimestampSchema,
  retiredAt: TimestampSchema,
  runId: z.string().min(1).nullable(),
});
export type CartHistoryEntry = z.infer<typeof CartHistoryEntrySchema>;

export const SaleHistoryEntrySchema = z.object({
  productId: z.string().min(1),
  intentId: z.string().min(1),
  cartId: z.string().min(1).nullable(),
  runId: z.string().min(1).nullable(),
  market: z.string().min(1),
  shopItem: z.string().min(1),
  quantity: QuantitySchema,
  unit: z.string().min(1),
  priceKobo: KoboSchema,
  soldAt: TimestampSchema,
});
export type SaleHistoryEntry = z.infer<typeof SaleHistoryEntrySchema>;

/** Archive-owned, participant-scoped history. Media references are deliberately absent. */
export const ParticipantHistorySchema = z.object({
  carts: z.array(CartHistoryEntrySchema),
  sales: z.array(SaleHistoryEntrySchema),
  runs: z.array(AdminRunSummarySchema),
});
export type ParticipantHistory = z.infer<typeof ParticipantHistorySchema>;
