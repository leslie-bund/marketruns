import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  acceptProduct,
  checkout,
  marketStub,
  offerProduct,
  postIntent,
  readJson,
  setMarketConfig,
  shiftTime,
} from "./helpers.js";

const BASE = "http://edge";

function postJson(path: string, body: unknown, participantId?: string): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (participantId !== undefined) {
    headers.set("x-participant-id", participantId);
    headers.set("x-participant-role", "buyer");
  }
  return SELF.fetch(new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

function getJson(path: string, participantId?: string): Promise<Response> {
  const headers = new Headers();
  if (participantId !== undefined) {
    headers.set("x-participant-id", participantId);
    headers.set("x-participant-role", "buyer");
  }
  return SELF.fetch(new Request(`${BASE}${path}`, { headers }));
}

/** Drive a buyer from intent to accepted product over the public surface; returns the cart id the edge assigned. */
async function driveToCart(market: string, buyerId: string, suffix: string): Promise<string> {
  const intentId = `${market}-intent-${suffix}`;
  const productId = `${market}-product-${suffix}`;

  const posted = await postJson(
    "/command",
    {
      type: "intent.posted", intentId, shopItem: "Tomatoes", quantity: 2, unit: "kg",
      priceBand: { minKobo: 120_000, maxKobo: 180_000 }, market,
    },
    buyerId,
  );
  expect(posted.status).toBe(200);

  const offered = await postJson(`/markets/${market}/offers`, {
    productId, intentId, market, shopItem: "Tomatoes", quantity: 2, unit: "kg",
    priceKobo: 165_000, sellerName: "Amina's Fresh Store", exchangePoint: `${market} Market, Stall B14`,
  });
  expect(offered.status).toBe(200);

  const accepted = await postJson("/command", { type: "product.accepted", productId }, buyerId);
  expect(accepted.status).toBe(200);
  const event = await readJson(accepted);
  expect(event.type).toBe("cart.updated");
  return String((event.cart as { id: string }).id);
}

/**
 * Per-buyer carts (cart:<market>:<buyerId>): two concurrent buyers in one
 * market no longer share a cart, their checkouts seed separate runs, and one
 * buyer cannot check out the other's cart.
 */
describe("per-buyer cart and run keys", () => {
  it("two buyers accept → separate carts, separate runs, concurrent checkouts do not collide", async () => {
    const cartA = await driveToCart("iso", "buyer:iso-a", "a");
    const cartB = await driveToCart("iso", "buyer:iso-b", "b");
    expect(cartA).toBe("cart:iso:buyer:iso-a");
    expect(cartB).toBe("cart:iso:buyer:iso-b");

    // One buyer cannot check out the other's cart.
    const poached = await postJson(
      "/command",
      { type: "checkout.requested", cartId: cartB, delivery: { kind: "plus-code", plusCode: "6FR5+8X Lagos" } },
      "buyer:iso-a",
    );
    expect(poached.status).toBe(409);

    // Concurrent checkouts: each lands on its own cart and seeds its own run.
    const delivery = { kind: "plus-code", plusCode: "6FR5+8X Lagos" };
    const [checkoutA, checkoutB] = await Promise.all([
      postJson("/command", { type: "checkout.requested", cartId: cartA, delivery }, "buyer:iso-a"),
      postJson("/command", { type: "checkout.requested", cartId: cartB, delivery }, "buyer:iso-b"),
    ]);
    expect(checkoutA.status).toBe(200);
    expect(checkoutB.status).toBe(200);
    const eventA = await readJson(checkoutA);
    const eventB = await readJson(checkoutB);
    expect(eventA.runId).toBe("run:cart:iso:buyer:iso-a");
    expect(eventB.runId).toBe("run:cart:iso:buyer:iso-b");
    expect(eventA.runId).not.toBe(eventB.runId);
  });

  it("the header-keyed cart read returns the caller's own cart", async () => {
    const cartId = await driveToCart("isr", "buyer:isr-a", "a");
    const mine = await getJson("/markets/isr/cart", "buyer:isr-a");
    expect(mine.status).toBe(200);
    const event = await readJson(mine);
    expect(event.type).toBe("cart.updated");
    expect(String((event.cart as { id: string }).id)).toBe(cartId);

    // Another buyer has no cart in this market.
    const other = await getJson("/markets/isr/cart", "buyer:isr-b");
    expect(other.status).toBe(404);
  });
});

/**
 * Dev-stage close-gate rollover (ADR-0013): an auto-generated config whose
 * closeAt has passed rolls forward by the default open window when next
 * evaluated; an ops-set config never rolls — an ops-closed market stays closed.
 */
describe("market close-gate rollover", () => {
  it("an expired auto-generated closeAt rolls forward and the gate opens", async () => {
    // First config read materialises the default config (now + 8h).
    const first = await getJson("/markets/ro/config");
    expect(first.status).toBe(200);
    const initial = await readJson(first);
    const initialCloseAt = Number(initial.closeAt);
    expect(initial.opsConfigured).toBe(false);

    // Jump the market's clock past closeAt: the gate still opens because the
    // auto-generated config rolls forward by the default window.
    const stub = marketStub("ro");
    await shiftTime(stub, 9 * 60 * 60 * 1000);
    const gate = await getJson("/markets/ro/close-gate");
    expect(gate.status).toBe(200);
    const gateBody = await readJson(gate);
    expect(gateBody.ok).toBe(true);
    expect(Number(gateBody.closeAt)).toBeGreaterThan(initialCloseAt);

    // The rollover persisted: a second read returns the rolled closeAt.
    const again = await readJson(await getJson("/markets/ro/config"));
    expect(Number(again.closeAt)).toBe(Number(gateBody.closeAt));
  });

  it("an ops-set past closeAt stays closed — no rollover", async () => {
    const past = Date.now() - 60_000;
    const written = await setMarketConfig("rox", { closeAt: past });
    expect(written.status).toBe(200);
    expect((await readJson(written)).opsConfigured).toBe(true);

    const gate = await getJson("/markets/rox/close-gate");
    expect(gate.status).toBe(200);
    const gateBody = await readJson(gate);
    expect(gateBody.ok).toBe(false);
    expect(String(gateBody.refusal)).toContain("closes at");
    expect(Number(gateBody.closeAt)).toBe(past);

    // Even after the market's clock moves, the ops-set close never rolls.
    const stub = marketStub("rox");
    await shiftTime(stub, 60 * 60 * 1000);
    const later = await readJson(await getJson("/markets/rox/config"));
    expect(Number(later.closeAt)).toBe(past);
  });
});

/** Disputes record who raised them: the header identity is adopted at the route (ADR-0015). */
describe("dispute attribution", () => {
  it("records raisedByParticipantId from the identity headers; a second dispute is 409", async () => {
    expect((await postIntent("dsp-intent-1", "dsp", "buyer:dsp")).status).toBe(200);
    expect((await offerProduct("dsp-product-1", "dsp-intent-1", "dsp")).status).toBe(200);
    expect((await acceptProduct("dsp-product-1", "buyer:dsp")).status).toBe(200);
    const accepted = await checkout("cart:dsp:buyer:dsp", { kind: "plus-code", plusCode: "6FR5+8X Lagos" }, "buyer:dsp");
    expect(accepted.status).toBe(200);
    const runId = String((await readJson(accepted)).runId);

    const raised = await postJson(`/runs/${runId}/dispute`, { reason: "items missing from the bag" }, "buyer:dsp");
    expect(raised.status).toBe(200);
    const body = await readJson(raised);
    expect(body.disputed).toBe(true);
    expect(body.reason).toBe("items missing from the bag");
    expect(body.raisedByParticipantId).toBe("buyer:dsp");

    const again = await postJson(`/runs/${runId}/dispute`, { reason: "still unhappy" }, "buyer:dsp");
    expect(again.status).toBe(409);
  });

  it("anonymous disputes still work, with no attribution", async () => {
    expect((await postIntent("dsp-intent-2", "dsp2")).status).toBe(200);
    expect((await offerProduct("dsp-product-2", "dsp-intent-2", "dsp2")).status).toBe(200);
    expect((await acceptProduct("dsp-product-2")).status).toBe(200);
    const accepted = await checkout("cart:dsp2:buyer:anonymous");
    expect(accepted.status).toBe(200);
    const runId = String((await readJson(accepted)).runId);

    const raised = await postJson(`/runs/${runId}/dispute`, { reason: "late delivery" });
    expect(raised.status).toBe(200);
    expect((await readJson(raised)).raisedByParticipantId).toBeNull();
  });
});
