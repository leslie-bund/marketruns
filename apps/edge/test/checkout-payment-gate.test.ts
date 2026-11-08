import { fetchMock, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptProduct,
  cartStub,
  checkout,
  internalPost,
  offerProduct,
  postIntent,
  readJson,
} from "./helpers.js";

/**
 * The checkout payment gate (Env.PAYMENTS_REQUIRED): OFF is the dev default —
 * checkout works unpaid, exactly as before. ON requires `paymentRef` naming a
 * payments-worker hold that is `held`, belongs to this cart and buyer, and
 * covers the checkout total (goods + delivery); on pass the hold is bound to
 * the run (the refund rail looks holds up by runId at settlement).
 *
 * The payments worker is mocked at the fetch boundary (fetchMock). Each test
 * uses its own market namespace (one open cart per buyer per market — a
 * refused checkout leaves the cart open, so reuse would compound totals).
 */

const PAYMENTS_ORIGIN = "http://localhost:8790";
// Default test flow: 165_000 kobo goods + 170_000 kobo floor-rate delivery.
const CHECKOUT_TOTAL_KOBO = 335_000;

interface Case {
  market: string;
  cartId: string;
  txRef: string;
}

function testCase(tag: string): Case {
  return { market: `pg-${tag}`, cartId: `cart:pg-${tag}:buyer:anonymous`, txRef: `mr-pg-${tag}` };
}

function holdView(kase: Case, overrides: Record<string, unknown> = {}) {
  return {
    id: `hold:${kase.txRef}`,
    txRef: kase.txRef,
    providerTxId: "9049104",
    cartId: kase.cartId,
    runId: null,
    buyerId: "buyer:anonymous",
    amountKobo: CHECKOUT_TOTAL_KOBO,
    paymentMethod: "card",
    status: "held",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Toggle the gate on the cart DO instance's env (the repo's env-override
 * pattern — cf. withOpsToken in ops-admin.test.ts — applied to the Durable
 * Object instance, since global binding mutation does not reach DOs).
 */
async function setGate(kase: Case, on: boolean) {
  await runInDurableObject(cartStub(kase.cartId), async (instance) => {
    (instance as unknown as { env: { PAYMENTS_REQUIRED?: string } }).env.PAYMENTS_REQUIRED = on ? "true" : "";
  });
}

async function freshCart(kase: Case) {
  expect((await postIntent(`${kase.market}-intent-1`, kase.market)).status).toBe(200);
  expect((await offerProduct(`${kase.market}-product-1`, `${kase.market}-intent-1`, kase.market)).status).toBe(200);
  expect((await acceptProduct(`${kase.market}-product-1`)).status).toBe(200);
}

describe("CartDO checkout payment gate", () => {
  const cases: Case[] = [];
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterAll(async () => {
    for (const kase of cases) await setGate(kase, false);
    fetchMock.deactivate();
  });

  it("gate ON without paymentRef refuses with payment-required and keeps the cart open", async () => {
    const kase = testCase("1");
    cases.push(kase);
    await freshCart(kase);
    await setGate(kase, true);
    const refused = await checkout(kase.cartId);
    expect(refused.status).toBe(409);
    expect((await readJson(refused)).error).toBe("payment-required");

    const view = await cartStub(kase.cartId).fetch(new Request("http://do/"));
    expect(((await view.json()) as { cart: { status: string } }).cart.status).toBe("open");
  });

  it("gate ON: an unknown paymentRef refuses with payment-hold-not-found", async () => {
    const kase = testCase("2");
    cases.push(kase);
    await freshCart(kase);
    fetchMock
      .get(PAYMENTS_ORIGIN)
      .intercept({ path: `/payments/holds/${kase.txRef}`, method: "GET" })
      .reply(404, JSON.stringify({ error: "not-found" }), { headers: { "content-type": "application/json" } });
    await setGate(kase, true);
    const refused = await checkout(kase.cartId, undefined, undefined, kase.txRef);
    expect(refused.status).toBe(409);
    expect((await readJson(refused)).error).toBe("payment-hold-not-found");
  });

  it("gate ON: a hold short of the checkout total refuses with payment-hold-insufficient", async () => {
    const kase = testCase("3");
    cases.push(kase);
    await freshCart(kase);
    fetchMock
      .get(PAYMENTS_ORIGIN)
      .intercept({ path: `/payments/holds/${kase.txRef}`, method: "GET" })
      .reply(200, JSON.stringify(holdView(kase, { amountKobo: CHECKOUT_TOTAL_KOBO - 1 })), {
        headers: { "content-type": "application/json" },
      });
    await setGate(kase, true);
    const refused = await checkout(kase.cartId, undefined, undefined, kase.txRef);
    expect(refused.status).toBe(409);
    expect((await readJson(refused)).error).toBe("payment-hold-insufficient");
  });

  it("gate ON: a covering hold passes checkout and gets bound to the run with service auth", async () => {
    const kase = testCase("4");
    cases.push(kase);
    await freshCart(kase);
    await runInDurableObject(cartStub(kase.cartId), async (instance) => {
      (instance as unknown as { env: { PAYMENTS_INTERNAL_TOKEN?: string } }).env.PAYMENTS_INTERNAL_TOKEN = "cart-payments-internal-test-token";
    });
    const pool = fetchMock.get(PAYMENTS_ORIGIN);
    let verifyHeaders: Record<string, string> | undefined;
    pool
      .intercept({ path: `/payments/holds/${kase.txRef}`, method: "GET" })
      .reply(200, (opts) => {
        verifyHeaders = opts.headers as Record<string, string>;
        return JSON.stringify(holdView(kase));
      }, { headers: { "content-type": "application/json" } });
    let bindBody: unknown = null;
    let bindHeaders: Record<string, string> | undefined;
    pool
      .intercept({ path: `/payments/holds/${kase.txRef}/bind`, method: "POST" })
      .reply(200, (opts) => {
        bindBody = opts.body;
        bindHeaders = opts.headers as Record<string, string>;
        return JSON.stringify({ status: "bound" });
      });

    await setGate(kase, true);
    const accepted = await checkout(kase.cartId, undefined, undefined, kase.txRef);
    expect(accepted.status).toBe(200);
    const body = await readJson(accepted);
    expect(body.type).toBe("checkout.accepted");
    expect(body.runId).toBe(`run:cart:pg-4:buyer:anonymous`);
    expect(JSON.parse(String(bindBody))).toEqual({ runId: `run:${kase.cartId}` });
    expect(verifyHeaders?.["x-payments-internal"]).toBe("cart-payments-internal-test-token");
    expect(bindHeaders?.["x-payments-internal"]).toBe("cart-payments-internal-test-token");
  });

  it("gate ON: exact top-up holds aggregate and every hold binds to the run", async () => {
    const kase = testCase("6");
    const topUpRef = `${kase.txRef}-topup`;
    cases.push(kase);
    await freshCart(kase);
    const pool = fetchMock.get(PAYMENTS_ORIGIN);
    pool.intercept({ path: `/payments/holds/${kase.txRef}`, method: "GET" })
      .reply(200, JSON.stringify(holdView(kase, { amountKobo: CHECKOUT_TOTAL_KOBO - 35_000 })), { headers: { "content-type": "application/json" } });
    pool.intercept({ path: `/payments/holds/${topUpRef}`, method: "GET" })
      .reply(200, JSON.stringify(holdView(kase, { id: `hold:${topUpRef}`, txRef: topUpRef, amountKobo: 35_000 })), { headers: { "content-type": "application/json" } });
    const bound: string[] = [];
    for (const ref of [kase.txRef, topUpRef]) {
      pool.intercept({ path: `/payments/holds/${ref}/bind`, method: "POST" }).reply(200, () => {
        bound.push(ref);
        return JSON.stringify({ status: "bound" });
      });
    }

    await setGate(kase, true);
    const accepted = await cartStub(kase.cartId).fetch(internalPost("/checkout", {
      type: "checkout.requested",
      cartId: kase.cartId,
      delivery: { kind: "plus-code", plusCode: "6FR5+8X Lagos" },
      paymentRef: kase.txRef,
      paymentRefs: [topUpRef],
    }));
    expect(accepted.status).toBe(200);
    expect(bound).toEqual([kase.txRef, topUpRef]);
  });

  it("gate OFF (dev default): checkout works unpaid, unchanged", async () => {
    const kase = testCase("5");
    cases.push(kase);
    await freshCart(kase);
    await setGate(kase, false);
    const accepted = await checkout(kase.cartId);
    expect(accepted.status).toBe(200);
    expect((await readJson(accepted)).type).toBe("checkout.accepted");
  });
});
