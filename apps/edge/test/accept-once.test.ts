import { describe, expect, it } from "vitest";
import {
  acceptProduct,
  offerProduct,
  postIntent,
  productStub,
  readJson,
} from "./helpers.js";

/**
 * The ProductDO is single-threaded, so accept-once is atomic: the first
 * accept transitions the product to "accepted" and every later accept is a
 * 409 — the product is sold exactly once (GLOSSARY.md).
 */
describe("ProductDO accept-once", () => {
  it("accepts a product into the cart exactly once; the second accept is 409", async () => {
    expect((await postIntent("ao-intent-1", "ao")).status).toBe(200);
    const offered = await offerProduct("ao-product-1", "ao-intent-1", "ao");
    expect(offered.status).toBe(200);

    const first = await acceptProduct("ao-product-1");
    expect(first.status).toBe(200);
    const accepted = await readJson(first);
    expect(accepted.type).toBe("cart.updated");
    const cart = accepted.cart as { id: string; acceptanceCount: number; products: Array<{ id: string; status: string }> };
    expect(cart.id).toBe("cart:ao:buyer:anonymous");
    expect(cart.acceptanceCount).toBe(1);
    expect(cart.products[0]?.status).toBe("accepted");

    const second = await acceptProduct("ao-product-1");
    expect(second.status).toBe(409);
    const refusal = await readJson(second);
    expect(refusal.message).toContain("already accepted");
  });

  it("closes the negotiation once accepted — no further price adjustments", async () => {
    expect((await postIntent("ao-intent-2", "ao")).status).toBe(200);
    expect((await offerProduct("ao-product-2", "ao-intent-2", "ao")).status).toBe(200);
    expect((await acceptProduct("ao-product-2")).status).toBe(200);

    const adjust = await productStub("ao-product-2").fetch(
      new Request("http://do/price", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "negotiation.price-adjusted",
          productId: "ao-product-2",
          by: "seller",
          priceKobo: 150_000,
          at: Date.now(),
        }),
      }),
    );
    expect(adjust.status).toBe(409);
  });
});
