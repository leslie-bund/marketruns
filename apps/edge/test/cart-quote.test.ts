import { describe, expect, it } from "vitest";
import {
  acceptProduct,
  cartStub,
  internalPost,
  offerProduct,
  postIntent,
  readJson,
  runStub,
  shiftTime,
} from "./helpers.js";

const DELIVERY = { kind: "plus-code" as const, plusCode: "6FR5+8X Lagos" };

async function freshCart(market: string): Promise<string> {
  const cartId = `cart:${market}:buyer:anonymous`;
  expect((await postIntent(`${market}-intent`, market)).status).toBe(200);
  expect((await offerProduct(`${market}-product`, `${market}-intent`, market)).status).toBe(200);
  expect((await acceptProduct(`${market}-product`)).status).toBe(200);
  return cartId;
}

async function quote(cartId: string): Promise<Response> {
  return cartStub(cartId).fetch(internalPost("/quote", { delivery: DELIVERY }, new Headers({ "x-participant-id": "buyer:anonymous" })));
}

describe("CartDO collection quote", () => {
  it("quotes goods + floor delivery without settlement margins and has no checkout side effects", async () => {
    const market = "quote-basic";
    const cartId = await freshCart(market);
    const response = await quote(cartId);
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.goodsKobo).toBe(165_000);
    expect(body.deliveryKobo).toBe(170_000);
    expect(body.totalKobo).toBe(335_000);
    expect(body.quoteId).toEqual(expect.any(String));

    const cart = await readJson(await cartStub(cartId).fetch(new Request("http://do/")));
    expect((cart.cart as { status: string }).status).toBe("open");
    expect((await runStub(`run:${cartId}`).fetch(new Request("http://do/"))).status).toBe(404);

    const accepted = await cartStub(cartId).fetch(internalPost("/checkout", {
      type: "checkout.requested",
      cartId,
      delivery: DELIVERY,
      quoteId: body.quoteId,
    }));
    expect(accepted.status).toBe(200);
    expect((await readJson(accepted)).floorRateKobo).toBe(170_000);
  });

  it("expires a quote instead of silently rerouting to a different collection total", async () => {
    const market = "quote-expiry";
    const cartId = await freshCart(market);
    const body = await readJson(await quote(cartId));
    await shiftTime(cartStub(cartId), 6 * 60_000);
    const refused = await cartStub(cartId).fetch(internalPost("/checkout", {
      type: "checkout.requested",
      cartId,
      delivery: DELIVERY,
      quoteId: body.quoteId,
    }));
    expect(refused.status).toBe(409);
    expect((await readJson(refused)).error).toBe("quote-expired");
    expect((await cartStub(cartId).fetch(new Request("http://do/"))).status).toBe(200);
  });

  it("rejects a quote for a different delivery", async () => {
    const market = "quote-mismatch";
    const cartId = await freshCart(market);
    const body = await readJson(await quote(cartId));
    const refused = await cartStub(cartId).fetch(internalPost("/checkout", {
      type: "checkout.requested",
      cartId,
      delivery: { kind: "muster-point", name: "Balogun Market Partner" },
      quoteId: body.quoteId,
    }));
    expect(refused.status).toBe(409);
    expect((await readJson(refused)).error).toBe("quote-mismatch");
  });
});
