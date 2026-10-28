import { describe, expect, it } from "vitest";
import { mapServerEvent } from "../src/mapper.js";

describe("recipient-specific notification deep links", () => {
  it("opens buyer and seller negotiations on their own product thread", () => {
    const base = {
      type: "negotiation.price-adjusted",
      productId: "product:1",
      priceKobo: 1000,
      at: 1000,
      buyerId: "buyer:1",
      sellerParticipantId: "seller:1",
    };
    const seller = mapServerEvent("source:seller", 1000, { ...base, by: "buyer" });
    expect(seller).toHaveLength(1);
    expect(seller[0]).toMatchObject({
      recipientId: "seller:1",
      deepLink: "/seller/negotiation?productId=product%3A1",
      data: { productId: "product:1" },
    });
    const buyer = mapServerEvent("source:buyer", 1000, { ...base, by: "seller" });
    expect(buyer[0]).toMatchObject({
      recipientId: "buyer:1",
      deepLink: "/buyer/negotiation?productId=product%3A1",
    });
  });

  it("preserves intent, product, run, and handoff ids", () => {
    const offer = mapServerEvent("source:offer", 1000, {
      type: "product.offered",
      buyerId: "buyer:1",
      product: {
        id: "product:1", intentId: "intent:1", shopItem: "Tomatoes", quantity: 2, unit: "kg",
        priceKobo: 1000, sellerName: "Store", sellerParticipantId: "seller:1", exchangePoint: "Stall",
        expiresAt: 2000, status: "available",
      },
    });
    expect(offer[0]?.deepLink).toBe("/buyer/products?intentId=intent%3A1&productId=product%3A1");

    const handoffs = mapServerEvent("source:handoff", 1000, {
      type: "handoff.initiated",
      handoffId: "handoff:1", handoffType: "pickup", runId: "run:1", exchangePointId: "Stall",
      counterparty: "Store", requestedAt: 1000, deadline: 2000,
      buyerId: "buyer:1", runnerId: "runner:1", sellerParticipantIds: ["seller:1"],
    });
    expect(Object.fromEntries(handoffs.map((draft) => [draft.recipientId, draft.deepLink]))).toEqual({
      "buyer:1": "/buyer/run?runId=run%3A1&handoffId=handoff%3A1",
      "runner:1": "/runner/handoff?runId=run%3A1&handoffId=handoff%3A1",
      "seller:1": "/seller/trip?runId=run%3A1&handoffId=handoff%3A1",
    });
  });

  it("routes every retired-run recipient to the archive receipt", () => {
    const drafts = mapServerEvent("source:retired", 1000, {
      type: "run.retired", runId: "run:1", cartId: "cart:1", market: "Balogun",
      buyerId: "buyer:1", runnerId: "runner:1", status: "closed", floorRateKobo: 1000,
      delivery: { kind: "muster-point", name: "Gate" }, stops: [], mode: "completed",
      settlementLegs: [{ sellerId: "seller:1", amountKobo: 1000 }], runnerKobo: 100,
      platformKobo: 0, buyerRefundKobo: 0, platformLossKobo: 0, closedAt: 1000,
    });
    expect(drafts).toHaveLength(3);
    expect(drafts.every((draft) => draft.deepLink === "/receipt?runId=run%3A1&status=closed")).toBe(true);
  });
});
