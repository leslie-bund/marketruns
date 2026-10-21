import { describe, expect, it } from "vitest";
import {
  acceptProduct,
  cartStub,
  checkout,
  offerProduct,
  postIntent,
  readJson,
  setMarketConfig,
} from "./helpers.js";

/**
 * The market close gate (domain marketCloseGateOk): when the market is too
 * close to closing for the estimated trip plus buffer, checkout is refused
 * clearly — and the cart survives the refusal untouched.
 */
describe("CartDO checkout close gate", () => {
  it("refuses checkout when the trip cannot finish before market close", async () => {
    const now = Date.now();
    const config = await setMarketConfig("cg", {
      closeAt: now + 5 * 60 * 1000, // closes in 5 min…
      estTripMs: 10 * 60 * 1000, // …but the trip needs 10 + 5 buffer
      bufferMs: 5 * 60 * 1000,
    });
    expect(config.status).toBe(200);

    expect((await postIntent("cg-intent-1", "cg")).status).toBe(200);
    expect((await offerProduct("cg-product-1", "cg-intent-1", "cg")).status).toBe(200);
    expect((await acceptProduct("cg-product-1")).status).toBe(200);

    const refused = await checkout("cart:cg:buyer:anonymous");
    expect(refused.status).toBe(409);
    const body = await readJson(refused);
    expect(body.error).toBe("market-close-gate");
    expect(String(body.refusal)).toContain("closes at");

    // The cart is still open and checkout can be retried after reopening.
    const view = await cartStub("cart:cg:buyer:anonymous").fetch(new Request("http://do/"));
    expect(view.status).toBe(200);
    const cart = (await readJson(view)).cart as { status: string };
    expect(cart.status).toBe("open");
  });

  it("accepts checkout when the gate is open", async () => {
    const now = Date.now();
    expect(
      (
        await setMarketConfig("cg", {
          closeAt: now + 8 * 60 * 60 * 1000,
          estTripMs: 20 * 60 * 1000,
          bufferMs: 5 * 60 * 1000,
        })
      ).status,
    ).toBe(200);

    expect((await postIntent("cg-intent-2", "cg")).status).toBe(200);
    expect((await offerProduct("cg-product-3", "cg-intent-2", "cg")).status).toBe(200);
    expect((await acceptProduct("cg-product-3")).status).toBe(200);

    const accepted = await checkout("cart:cg:buyer:anonymous");
    expect(accepted.status).toBe(200);
    const body = await readJson(accepted);
    expect(body.type).toBe("checkout.accepted");
    expect(body.runId).toBe("run:cart:cg:buyer:anonymous");
    expect(body.floorRateKobo).toBe(170_000); // default config floor rate
  });
});
