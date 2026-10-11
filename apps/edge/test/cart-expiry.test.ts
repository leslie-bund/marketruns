import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  acceptProduct,
  cartStub,
  offerProduct,
  postIntent,
  productStub,
  readJson,
  shiftTime,
} from "./helpers.js";

/**
 * ADR-0003: on deadline expiry the whole cart retires atomically — every
 * unbought product retires together and none is ever resurrected.
 */
describe("CartDO shared lap-timer deadline", () => {
  it("deadline expiry retires the cart and every product; nothing is resurrectable", async () => {
    expect((await postIntent("ce-intent-1", "ce")).status).toBe(200);
    expect((await offerProduct("ce-product-1", "ce-intent-1", "ce")).status).toBe(200);
    expect((await offerProduct("ce-product-2", "ce-intent-1", "ce", 90_000)).status).toBe(200);

    expect((await acceptProduct("ce-product-1")).status).toBe(200);
    const secondAccept = await acceptProduct("ce-product-2");
    expect(secondAccept.status).toBe(200);
    const cart = (await readJson(secondAccept)).cart as { acceptanceCount: number };
    expect(cart.acceptanceCount).toBe(2);

    // Move the cart clock past its deadline (first acceptance + 40 min < 61 min).
    const stub = cartStub("cart:ce");
    await shiftTime(stub, 61 * 60 * 1000);
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    // The cart is retired: its state is gone.
    const view = await stub.fetch(new Request("http://do/"));
    expect(view.status).toBe(404);

    // No product in the cart is resurrectable: re-accepts and views both fail.
    for (const productId of ["ce-product-1", "ce-product-2"]) {
      const reaccept = await acceptProduct(productId);
      expect(reaccept.status).toBe(404);
      const productView = await productStub(productId).fetch(new Request("http://do/"));
      expect(productView.status).toBe(404);
    }
  });
});
