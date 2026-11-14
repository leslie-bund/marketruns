import { describe, expect, it } from "vitest";
import { archiveQueueMessages } from "../../../infra/drizzle/schema.js";
import { archiveQueueEntry, recordArchiveQueueReceipt } from "../src/queue-receipts.js";
import type { ArchiveTx } from "../src/persist.js";

function receiptTx() {
  let conflictSet: Record<string, unknown> | null = null;
  const tx = {
    insert() {
      return {
        values() {
          return {
            async onConflictDoUpdate(input: { set: Record<string, unknown> }) {
              conflictSet = input.set;
            },
          };
        },
      };
    },
  } as unknown as ArchiveTx;
  return { tx, conflictSet: () => conflictSet };
}

describe("archive queue receipts", () => {
  it("counts only a fresh receipt as a delivery attempt", async () => {
    const first = receiptTx();
    await recordArchiveQueueReceipt(first.tx, { id: "message-1", eventType: "cart.retired", status: "received" });
    expect(first.conflictSet()).toHaveProperty("attempts");

    const completed = receiptTx();
    await recordArchiveQueueReceipt(completed.tx, { id: "message-1", eventType: "cart.retired", status: "persisted" });
    expect(completed.conflictSet()?.attempts).toBe(archiveQueueMessages.attempts);
    expect(completed.conflictSet()?.completedAt).toBeInstanceOf(Date);
  });

  it("maps durable timestamps and errors to the ops wire", () => {
    const now = new Date();
    expect(archiveQueueEntry({
      id: "message-1",
      eventType: "product.retired",
      status: "retrying",
      attempts: 2,
      requestId: "request-1",
      error: "database unavailable",
      firstReceivedAt: now,
      updatedAt: now,
      completedAt: null,
    })).toEqual({
      id: "message-1",
      eventType: "product.retired",
      status: "retrying",
      attempts: 2,
      requestId: "request-1",
      error: "database unavailable",
      firstReceivedAt: now.getTime(),
      updatedAt: now.getTime(),
      completedAt: null,
    });
  });
});
