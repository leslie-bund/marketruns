import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  CartRetiredSchema,
  CartUpdatedSchema,
  CheckoutAcceptedSchema,
  CheckoutRequestedSchema,
  ClientCommandSchema,
  HandoffChallengeScannedSchema,
  HandoffConfirmedSchema,
  IntentPostedSchema,
  IntentRecordedSchema,
  KycVerificationResultSchema,
  NegotiationPriceAdjustedSchema,
  PaymentHoldPlacedSchema,
  ProductAcceptedSchema,
  ProductOfferedSchema,
  ProductRetiredSchema,
  RunUpdatedSchema,
  RunnerLocationUpdatedSchema,
  ServerEventSchema,
  SettlementReleasedSchema,
  CartSchema,
  ProductSchema,
  RunSchema,
} from "../src/index.js";

/** Serialize → deserialize → parse, proving the wire format round-trips. */
function roundTrip<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}

const now = 1_761_000_000_000;

const tomatoProduct = {
  id: "product-1",
  intentId: "intent-1",
  shopItem: "Tomatoes",
  quantity: 2,
  unit: "kg",
  priceKobo: 165_000,
  sellerName: "Amina's Fresh Store",
  exchangePoint: "Balogun Market, Stall B14",
  expiresAt: now + 17 * 60_000,
  status: "available",
};

const cart = {
  id: "cart-1",
  market: "Balogun",
  products: [{ ...tomatoProduct, status: "accepted" }],
  firstAcceptedAt: now - 8 * 60_000,
  acceptanceCount: 1,
  deadline: now + 22 * 60_000,
  status: "open",
};

const run = {
  id: "run-1",
  market: "Balogun",
  status: "collecting",
  floorRateKobo: 180_000,
  delivery: { kind: "plus-code", plusCode: "6FR5+8X Lagos" },
  stops: [
    { sellerName: "Amina's Fresh Store", exchangePoint: "Balogun Market, Stall B14", shopItems: ["Tomatoes"], status: "next" },
  ],
  handoffs: [
    { id: "handoff-1", exchangePoint: "Balogun Market, Stall B14", counterparty: "Amina's Fresh Store", status: "pending", requestedAt: now - 40_000 },
  ],
};

describe("intent family", () => {
  it("parses a valid intent.posted command", () => {
    const parsed = IntentPostedSchema.parse({
      type: "intent.posted",
      intentId: "intent-1",
      shopItem: "Tomatoes",
      quantity: 2,
      unit: "kg",
      priceBand: { minKobo: 120_000, maxKobo: 180_000 },
      note: "Firm, ripe tomatoes please",
      market: "Balogun",
    });
    expect(parsed.priceBand.maxKobo).toBe(180_000);
  });

  it("rejects fractional kobo in the price band", () => {
    expect(
      IntentPostedSchema.safeParse({
        type: "intent.posted",
        intentId: "intent-1",
        shopItem: "Tomatoes",
        quantity: 2,
        unit: "kg",
        priceBand: { minKobo: 120_000.5, maxKobo: 180_000 },
        market: "Balogun",
      }).success,
    ).toBe(false);
  });

  it("rejects a price band whose min exceeds its max", () => {
    expect(
      IntentPostedSchema.safeParse({
        type: "intent.posted",
        intentId: "intent-1",
        shopItem: "Tomatoes",
        quantity: 2,
        unit: "kg",
        priceBand: { minKobo: 200_000, maxKobo: 180_000 },
        market: "Balogun",
      }).success,
    ).toBe(false);
  });

  it("round-trips intent.recorded", () => {
    const recorded = roundTrip(IntentRecordedSchema, {
      type: "intent.recorded",
      intent: {
        id: "intent-1",
        shopItem: "Tomatoes",
        quantity: 2,
        unit: "kg",
        priceBand: { minKobo: 120_000, maxKobo: 180_000 },
        note: "Firm, ripe tomatoes please",
        market: "Balogun",
        createdAt: now,
        status: "open",
      },
    });
    expect(recorded.intent.status).toBe("open");
  });
});

describe("product / negotiation family", () => {
  it("parses a valid product.offered event", () => {
    const offered = ProductOfferedSchema.parse({ type: "product.offered", product: tomatoProduct });
    expect(offered.product.priceKobo).toBe(165_000);
  });

  it("accepts a price adjustment from either side", () => {
    for (const by of ["buyer", "seller"] as const) {
      const adjusted = NegotiationPriceAdjustedSchema.parse({
        type: "negotiation.price-adjusted",
        productId: "product-1",
        by,
        priceKobo: 160_000,
        at: now,
      });
      expect(adjusted.by).toBe(by);
    }
  });

  it("rejects a negative negotiated price", () => {
    expect(
      NegotiationPriceAdjustedSchema.safeParse({
        type: "negotiation.price-adjusted",
        productId: "product-1",
        by: "buyer",
        priceKobo: -500,
        at: now,
      }).success,
    ).toBe(false);
  });
});

describe("cart family", () => {
  it("round-trips cart.updated with the shared lap-timer deadline", () => {
    const updated = roundTrip(CartUpdatedSchema, { type: "cart.updated", cart });
    expect(updated.cart.firstAcceptedAt).toBe(cart.firstAcceptedAt);
    expect(updated.cart.acceptanceCount).toBe(1);
    expect(updated.cart.deadline).toBe(cart.deadline);
  });

  it("accepts plus-code and muster-point delivery on checkout.requested", () => {
    const plusCode = CheckoutRequestedSchema.parse({
      type: "checkout.requested",
      cartId: "cart-1",
      delivery: { kind: "plus-code", plusCode: "6FR5+8X Lagos" },
    });
    expect(plusCode.delivery.kind).toBe("plus-code");

    const muster = CheckoutRequestedSchema.parse({
      type: "checkout.requested",
      cartId: "cart-1",
      delivery: { kind: "muster-point", name: "Mama Nkechi's Kiosk" },
    });
    expect(muster.delivery).toEqual({ kind: "muster-point", name: "Mama Nkechi's Kiosk" });
  });

  it("rejects a checkout delivery of unknown kind", () => {
    expect(
      CheckoutRequestedSchema.safeParse({
        type: "checkout.requested",
        cartId: "cart-1",
        delivery: { kind: "doorstep", address: "12 Admiralty Way" },
      }).success,
    ).toBe(false);
  });

  it("round-trips checkout.accepted at the floor rate", () => {
    const accepted = roundTrip(CheckoutAcceptedSchema, {
      type: "checkout.accepted",
      cartId: "cart-1",
      runId: "run-1",
      floorRateKobo: 180_000,
      delivery: { kind: "muster-point", name: "Mama Nkechi's Kiosk" },
    });
    expect(accepted.floorRateKobo).toBe(180_000);
  });
});

describe("run / handoff family", () => {
  it("round-trips run.updated", () => {
    const updated = roundTrip(RunUpdatedSchema, { type: "run.updated", run });
    expect(updated.run.status).toBe("collecting");
    expect(updated.run.stops[0]?.status).toBe("next");
  });

  it("parses an auto-confirmed handoff (buyer silence = consent)", () => {
    const confirmed = HandoffConfirmedSchema.parse({
      type: "handoff.confirmed",
      handoffId: "handoff-1",
      runId: "run-1",
      confirmedAt: now + 3 * 60_000,
      autoConfirmed: true,
    });
    expect(confirmed.autoConfirmed).toBe(true);
  });

  it("rejects a QR scan without a handoff reference", () => {
    expect(
      HandoffChallengeScannedSchema.safeParse({
        type: "handoff.challenge-scanned",
        runId: "run-1",
        scannedAt: now,
      }).success,
    ).toBe(false);
  });

  it("rejects out-of-range runner coordinates", () => {
    expect(
      RunnerLocationUpdatedSchema.safeParse({
        type: "run.location-updated",
        runId: "run-1",
        latitude: 91,
        longitude: 0,
        observedAt: now,
      }).success,
    ).toBe(false);
  });
});

describe("settlement family", () => {
  it("parses a completed settlement with integer kobo throughout", () => {
    const settled = SettlementReleasedSchema.parse({
      type: "settlement.released",
      runId: "run-1",
      mode: "completed",
      sellers: [{ sellerId: "seller-1", amountKobo: 250_000 }],
      runnerKobo: 180_000,
      platformKobo: 30_250,
      buyerRefundKobo: 0,
      platformLossKobo: 0,
      releasedAt: now,
    });
    expect(settled.mode).toBe("completed");
  });

  it("rejects an unknown settlement mode", () => {
    expect(
      SettlementReleasedSchema.safeParse({
        type: "settlement.released",
        runId: "run-1",
        mode: "refunded",
        sellers: [],
        runnerKobo: 0,
        platformKobo: 0,
        buyerRefundKobo: 250_000,
        platformLossKobo: 0,
        releasedAt: now,
      }).success,
    ).toBe(false);
  });

  it("rejects fractional kobo in the settlement outcome", () => {
    expect(
      SettlementReleasedSchema.safeParse({
        type: "settlement.released",
        runId: "run-1",
        mode: "completed",
        sellers: [{ sellerId: "seller-1", amountKobo: 250_000.4 }],
        runnerKobo: 180_000,
        platformKobo: 0,
        buyerRefundKobo: 0,
        platformLossKobo: 0,
        releasedAt: now,
      }).success,
    ).toBe(false);
  });
});

describe("archive family", () => {
  it("round-trips a product retirement snapshot", () => {
    const retired = roundTrip(ProductRetiredSchema, {
      type: "product.retired",
      productId: "product-1",
      intentId: "intent-1",
      reason: "sold",
      retiredAt: now,
      snapshot: { ...tomatoProduct, status: "accepted" },
    });
    expect(retired.reason).toBe("sold");
    expect(retired.snapshot.shopItem).toBe("Tomatoes");
  });

  it("round-trips a cart retirement snapshot (atomic expiry)", () => {
    const retired = roundTrip(CartRetiredSchema, {
      type: "cart.retired",
      cartId: "cart-1",
      market: "Balogun",
      reason: "deadline-expired",
      retiredAt: now,
      snapshot: { ...cart, status: "retired", products: [{ ...tomatoProduct, status: "retired" }] },
    });
    expect(retired.snapshot.products[0]?.status).toBe("retired");
  });
});

describe("payments / KYC family (ADR-0009)", () => {
  it("speaks in holds, captures, releases, and verifications — no vendor names", () => {
    const hold = PaymentHoldPlacedSchema.parse({
      type: "payment.hold-placed",
      holdId: "hold-1",
      amountKobo: 430_000,
      placedAt: now,
    });
    expect(hold.amountKobo).toBe(430_000);

    const kyc = KycVerificationResultSchema.parse({
      type: "kyc.verification-result",
      verificationId: "verification-1",
      status: "verified",
      verifiedAt: now,
    });
    expect(kyc.status).toBe("verified");
  });

  it("rejects a fractional hold amount", () => {
    expect(
      PaymentHoldPlacedSchema.safeParse({
        type: "payment.hold-placed",
        holdId: "hold-1",
        amountKobo: 430_000.01,
        placedAt: now,
      }).success,
    ).toBe(false);
  });
});

describe("wire unions", () => {
  it("ClientCommand discriminates every client-sent message", () => {
    for (const command of [
      IntentPostedSchema.parse({
        type: "intent.posted",
        intentId: "intent-1",
        shopItem: "Tomatoes",
        quantity: 2,
        unit: "kg",
        priceBand: { minKobo: 120_000, maxKobo: 180_000 },
        market: "Balogun",
      }),
      ProductAcceptedSchema.parse({ type: "product.accepted", productId: "product-1" }),
    ]) {
      expect(ClientCommandSchema.parse(command)).toEqual(command);
    }
  });

  it("rejects an unknown message type on both unions", () => {
    expect(ClientCommandSchema.safeParse({ type: "intent.deleted" }).success).toBe(false);
    expect(ServerEventSchema.safeParse({ type: "run.hacked" }).success).toBe(false);
  });

  it("nested record schemas are independently usable", () => {
    expect(CartSchema.parse(cart).deadline).toBe(cart.deadline);
    expect(ProductSchema.parse(tomatoProduct).status).toBe("available");
    expect(RunSchema.parse(run).floorRateKobo).toBe(180_000);
  });
});
