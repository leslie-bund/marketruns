import { describe, expect, it } from "vitest";
import { createApp } from "../src/app/app.js";
import type { Env } from "../src/config/env.js";
import {
  acceptProduct,
  bindings,
  offerProduct,
  postIntent,
  productStub,
  readJson,
  shiftTime,
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

  it("rejects acceptance after product TTL even before the retirement alarm runs", async () => {
    expect((await postIntent("ao-intent-expired", "ao-expired", "buyer:ao-expired")).status).toBe(200);
    expect((await offerProduct("ao-product-expired", "ao-intent-expired", "ao-expired")).status).toBe(200);
    await shiftTime(productStub("ao-product-expired"), 31 * 60 * 1000);

    const response = await acceptProduct("ao-product-expired", "buyer:ao-expired");

    expect(response.status).toBe(409);
    expect((await readJson(response)).error).toBe("product-expired");
  });

  it("keeps accepted-product replay precedence after the original product TTL", async () => {
    expect((await postIntent("ao-intent-accepted", "ao-accepted", "buyer:ao-accepted")).status).toBe(200);
    expect((await offerProduct("ao-product-accepted", "ao-intent-accepted", "ao-accepted")).status).toBe(200);
    expect((await acceptProduct("ao-product-accepted", "buyer:ao-accepted")).status).toBe(200);
    await shiftTime(productStub("ao-product-accepted"), 31 * 60 * 1000);

    const replay = await acceptProduct("ao-product-accepted", "buyer:ao-accepted");

    expect(replay.status).toBe(409);
    expect((await readJson(replay)).message).toContain("already accepted");
  });

  it("preserves header-less acceptance into the attributed intent buyer's cart", async () => {
    expect((await postIntent("ao-intent-demo", "ao-demo", "buyer:ao-demo")).status).toBe(200);
    expect((await offerProduct("ao-product-demo", "ao-intent-demo", "ao-demo")).status).toBe(200);

    const accepted = await acceptProduct("ao-product-demo");

    expect(accepted.status).toBe(200);
    expect(String((await readJson(accepted)).cart.id)).toBe("cart:ao-demo:buyer:ao-demo");
  });

  it("blocks unauthenticated callers on the alternate product acceptance route", async () => {
    expect((await postIntent("ao-intent-deployed", "ao-deployed", "buyer:ao-deployed")).status).toBe(200);
    expect((await offerProduct("ao-product-deployed", "ao-intent-deployed", "ao-deployed")).status).toBe(200);
    const env = new Proxy(bindings, {
      get: (target, prop, receiver) => prop === "ALLOW_HEADER_AUTH" ? undefined : Reflect.get(target, prop, receiver),
    }) as Env;

    const response = await createApp().fetch(
      new Request("http://edge/products/ao-product-deployed/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "product.accepted", productId: "ao-product-deployed" }),
      }),
      env,
    );

    expect(response.status).toBe(403);
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
