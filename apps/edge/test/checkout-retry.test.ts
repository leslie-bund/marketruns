import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { STATE_KEY } from "../src/do/state.js";
import {
  acceptProduct,
  cartStub,
  checkout,
  offerProduct,
  postIntent,
  readJson,
  runStub,
  setMarketConfig,
  shiftTime,
} from "./helpers.js";

/**
 * Adversarial finding: checkout.requested on a retired cart used to 404
 * ("cart is empty or retired") because retirement deleted ALL DO storage, so
 * a client that lost the original checkout response could never recover its
 * runId. The tombstone (ADR-0010's minimal exception): retirement deletes
 * everything except `{ retired, cartId, runId, retiredAt }`, and a retry
 * against the tombstoned cart gets 409 cart-already-checked-out WITH the
 * runId — never a second run.
 */
describe("CartDO checkout tombstone (retry recovery)", () => {
  async function checkedOutCart(tag: string): Promise<{ cartId: string; runId: string }> {
    const market = `cr-${tag}`;
    const now = Date.now();
    expect((await setMarketConfig(market, { closeAt: now + 8 * 60 * 60 * 1000 })).status).toBe(200);
    expect((await postIntent(`${market}-intent-1`, market)).status).toBe(200);
    expect((await offerProduct(`${market}-product-1`, `${market}-intent-1`, market)).status).toBe(200);
    expect((await acceptProduct(`${market}-product-1`)).status).toBe(200);

    const cartId = `cart:${market}:buyer:anonymous`;
    const accepted = await checkout(cartId);
    expect(accepted.status).toBe(200);
    const body = await readJson(accepted);
    expect(body.type).toBe("checkout.accepted");
    return { cartId, runId: String(body.runId) };
  }

  it("checkout retry returns 409 cart-already-checked-out with the same runId", async () => {
    const { cartId, runId } = await checkedOutCart("retry");

    const retry = await checkout(cartId);
    expect(retry.status).toBe(409);
    const body = await readJson(retry);
    expect(body.error).toBe("cart-already-checked-out");
    expect(body.runId).toBe(runId);
    expect(typeof body.retiredAt).toBe("number");

    // Retries stay idempotent forever: third attempt, same answer.
    const third = await checkout(cartId);
    expect(third.status).toBe(409);
    expect((await readJson(third)).runId).toBe(runId);
  });

  it("retirement leaves ONLY the tombstone in storage — no retained cart state", async () => {
    const { cartId, runId } = await checkedOutCart("storage");
    await runInDurableObject(cartStub(cartId), async (_instance, state) => {
      const keys = [...(await state.storage.list()).keys()];
      expect(keys).toEqual(["cart:tombstone"]);
      const tombstone = (await state.storage.get<{ retired: boolean; cartId: string; runId: string }>(
        "cart:tombstone",
      ))!;
      expect(tombstone.retired).toBe(true);
      expect(tombstone.cartId).toBe(cartId);
      expect(tombstone.runId).toBe(runId);
    });
  });

  it("the tombstoned cart still reads as no-active-cart (404) on the cart read path", async () => {
    const { cartId } = await checkedOutCart("read");
    const view = await cartStub(cartId).fetch(new Request("http://do/"));
    expect(view.status).toBe(404);
    expect(String((await readJson(view)).message)).toContain("empty or retired");
  });

  it("no second run is seeded — the existing run is untouched by the retry", async () => {
    const { cartId, runId } = await checkedOutCart("norun");

    const before = await runStub(runId).fetch(new Request("http://do/"));
    expect(before.status).toBe(200);
    const runBefore = (await readJson(before)).run as Record<string, unknown>;

    expect((await checkout(cartId)).status).toBe(409);

    const after = await runStub(runId).fetch(new Request("http://do/"));
    expect(after.status).toBe(200);
    expect((await readJson(after)).run).toEqual(runBefore);
  });

  it("a checkout naming a DIFFERENT unknown cart still 404s (no tombstone leak)", async () => {
    const { cartId } = await checkedOutCart("scope");
    const foreign = await cartStub(cartId).fetch(
      new Request("http://do/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "checkout.requested",
          cartId: "cart:cr-scope:buyer:someone-else",
          delivery: { kind: "plus-code", plusCode: "6FR5+8X Lagos" },
        }),
      }),
    );
    expect(foreign.status).toBe(404);
  });

  it("a new cart on the same DO checks out normally and refreshes the tombstone", async () => {
    const { cartId, runId } = await checkedOutCart("reuse");

    // The buyer fills a fresh cart (same deterministic cart id per buyer+market).
    const market = "cr-reuse";
    expect((await postIntent(`${market}-intent-2`, market)).status).toBe(200);
    expect((await offerProduct(`${market}-product-2`, `${market}-intent-2`, market)).status).toBe(200);
    expect((await acceptProduct(`${market}-product-2`)).status).toBe(200);

    const view = await cartStub(cartId).fetch(new Request("http://do/"));
    expect(view.status).toBe(200);

    const second = await checkout(cartId);
    expect(second.status).toBe(200);
    // RunDO seed idempotency (second line of defense): the deterministic
    // runId is unchanged and the original run is NOT re-seeded.
    expect(String((await readJson(second)).runId)).toBe(runId);
  });

  it("deadline expiry of a later cart preserves the checkout tombstone", async () => {
    const { cartId, runId } = await checkedOutCart("expiry");

    // Fill a second cart on the same DO and let it lapse.
    const market = "cr-expiry";
    expect((await postIntent(`${market}-intent-2`, market)).status).toBe(200);
    expect((await offerProduct(`${market}-product-2`, `${market}-intent-2`, market)).status).toBe(200);
    expect((await acceptProduct(`${market}-product-2`)).status).toBe(200);

    const stub = cartStub(cartId);
    await shiftTime(stub, 61 * 60 * 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // The expired cart is gone…
    expect((await stub.fetch(new Request("http://do/"))).status).toBe(404);
    // …but the checkout retry still recovers the original runId.
    const retry = await checkout(cartId);
    expect(retry.status).toBe(409);
    expect((await readJson(retry)).runId).toBe(runId);
  });
});
