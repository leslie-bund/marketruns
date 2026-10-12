import { describe, expect, it } from "vitest";
import { parseArchiveMessage } from "../src/messages.js";

describe("archive message parsing", () => {
  it("accepts run.retired snapshots", () => {
    expect(parseArchiveMessage({
      type: "run.retired", runId: "run:cart:a", cartId: "cart:a", market: "market-a", status: "closed",
      floorRateKobo: 1, delivery: { kind: "plus-code", plusCode: "ABC" }, stops: [], mode: "completed",
      settlementLegs: [], runnerKobo: 0, platformKobo: 0, buyerRefundKobo: 0, platformLossKobo: 0, closedAt: 1,
    }).success).toBe(true);
  });

  it("rejects unknown types and malformed payloads", () => {
    expect(parseArchiveMessage({ type: "run.retired" }).success).toBe(false);
    expect(parseArchiveMessage({ type: "run.updated" }).success).toBe(false);
  });
});
