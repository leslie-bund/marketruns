import {
  CartRetiredSchema,
  ProductRetiredSchema,
  RunRetiredSchema,
  RunStartedSchema,
  SettlementReleasedSchema,
} from "@market-runs/proto";
import { z } from "zod";

const ArchiveMessageSchema = ProductRetiredSchema
  .or(CartRetiredSchema)
  .or(RunStartedSchema)
  .or(RunRetiredSchema)
  .or(SettlementReleasedSchema);

export type ArchiveMessage = z.infer<typeof ArchiveMessageSchema>;

/**
 * Queue bodies arrive as JSON strings (the DOs serialize with
 * serializeEvent); accept both the string and the already-parsed object so
 * the consumer never dead-letters its own wire format.
 */
export function parseArchiveMessage(body: unknown) {
  if (typeof body === "string") {
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return ArchiveMessageSchema.safeParse(body);
    }
    return ArchiveMessageSchema.safeParse(raw);
  }
  return ArchiveMessageSchema.safeParse(body);
}
