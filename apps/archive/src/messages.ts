import {
  CartRetiredSchema,
  ProductRetiredSchema,
  RunRetiredSchema,
  SettlementReleasedSchema,
} from "@market-runs/proto";
import { z } from "zod";

const ArchiveMessageSchema = ProductRetiredSchema
  .or(CartRetiredSchema)
  .or(RunRetiredSchema)
  .or(SettlementReleasedSchema);

export type ArchiveMessage = z.infer<typeof ArchiveMessageSchema>;

export function parseArchiveMessage(body: unknown) {
  return ArchiveMessageSchema.safeParse(body);
}
