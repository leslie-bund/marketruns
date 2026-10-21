import { SELF, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readJson, runStub, shiftTime } from "./helpers.js";

/**
 * Functional integration tests: the whole MVP flow over the PUBLIC HTTP
 * surface (SELF — the same routes the apps and the ops console call), with
 * the run's WebSocket standing in for the archive queue to assert the exact
 * settlement/retirement payloads. Crosses intent → offer → negotiation →
 * accept → cart → checkout → handoffs → delivery → settlement, plus the
 * ops console's settle-only adjustment paths (ADR-0007/0008/0013).
 */

const BASE = "http://edge";

async function postJson(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function getJson(path: string): Promise<Response> {
  return SELF.fetch(new Request(`${BASE}${path}`));
}

async function attachRunSocket(runId: string): Promise<{ events: Array<Record<string, unknown>>; waitFor: (type: string) => Promise<Record<string, unknown>> }> {
  const upgrade = await runStub(runId).fetch(
    new Request("http://do/ws", { headers: { upgrade: "websocket" } }),
  );
  expect(upgrade.status).toBe(101);
  const ws = upgrade.webSocket;
  if (!ws) throw new Error("no client socket");
  ws.accept();
  const events: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (event) => {
    events.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  });
  const waitFor = async (type: string, attempts = 40): Promise<Record<string, unknown>> => {
    for (let i = 0; i < attempts; i += 1) {
      const found = events.find((event) => event.type === type);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`event ${type} never arrived; saw ${JSON.stringify(events.map((e) => e.type))}`);
  };
  return { events, waitFor };
}

/** Drive a market from intent to a live run; returns the run id. */
async function driveToRun(market: string, buyerId: string): Promise<{ runId: string; productId: string }> {
  const intentId = `e2e-intent-${market}`;
  const productId = `e2e-product-${market}`;

  const posted = await postJson("/command", {
    type: "intent.posted", intentId, shopItem: "Tomatoes", quantity: 2, unit: "kg",
    priceBand: { minKobo: 120_000, maxKobo: 180_000 }, note: "firm and ripe", market, buyerId,
  });
  expect(posted.status).toBe(200);
  expect((await readJson(posted)).type).toBe("intent.recorded");

  const offered = await postJson(`/markets/${market}/offers`, {
    productId, intentId, market, shopItem: "Tomatoes", quantity: 2, unit: "kg",
    priceKobo: 165_000, sellerName: "Amina's Fresh Store", exchangePoint: `${market} Market, Stall B14`,
  });
  expect(offered.status).toBe(200);

  const negotiated = await postJson("/command", {
    type: "negotiation.price-adjusted", productId, by: "buyer", priceKobo: 160_000, at: Date.now(),
  });
  expect(negotiated.status).toBe(200);

  const accepted = await postJson("/command", { type: "product.accepted", productId });
  expect(accepted.status).toBe(200);
  const acceptedEvent = await readJson(accepted);
  expect(acceptedEvent.type).toBe("cart.updated");
  // The edge is authoritative for the cart id: the client learns it from the
  // accept response (cart:<market>:<buyerId>) rather than deriving it.
  const cartId = String((acceptedEvent.cart as { id: string }).id);

  const checkoutResponse = await postJson("/command", {
    type: "checkout.requested", cartId, buyerId,
    delivery: { kind: "plus-code", plusCode: "6FR5+8X Lagos" },
  });
  expect(checkoutResponse.status).toBe(200);
  const checkoutEvent = await readJson(checkoutResponse);
  expect(checkoutEvent.type).toBe("checkout.accepted");
  expect(checkoutEvent.floorRateKobo).toBe(170_000);
  return { runId: String(checkoutEvent.runId), productId };
}

describe("end-to-end over the public HTTP surface", () => {
  it("intent → offer → negotiate → accept → checkout → handoff → delivery → settlement", async () => {
    const { runId } = await driveToRun("e2e", "buyer:e2e");
    expect(runId).toBe("run:cart:e2e:buyer:e2e");

    // The ops console sees the live run and the market overview (per-buyer
    // cart/run lookup via the buyerId query param).
    const overview = await readJson(await getJson("/ops/api/overview?market=e2e&buyerId=buyer:e2e"));
    expect(overview.market).toBe("e2e");
    const overviewRun = overview.run as { run: { status: string; stops: unknown[] } };
    expect(overviewRun.run.status).toBe("assigned");
    expect(overviewRun.run.stops).toHaveLength(1);

    const { waitFor } = await attachRunSocket(runId);

    const handoffId = "e2e-handoff-1";
    const initiated = await postJson(`/runs/${runId}/handoffs`, {
      handoffId, exchangePointId: "e2e Market, Stall B14", counterparty: "Amina's Fresh Store",
    });
    expect(initiated.status).toBe(200);
    expect((await readJson(initiated)).type).toBe("handoff.initiated");

    const photo = await postJson(`/runs/${runId}/handoffs/${handoffId}/photo`, {
      type: "handoff.photo-captured", handoffId,
      photoCaptureRef: "r2://archive/captures/e2e-handoff-1.jpg", capturedAt: Date.now(),
    });
    expect(photo.status).toBe(200);

    const scan = await postJson("/command", {
      type: "handoff.challenge-scanned", handoffId, runId, scannedAt: Date.now(),
    });
    expect(scan.status).toBe(200);
    expect((await readJson(scan)).type).toBe("handoff.confirmed");

    const location = await postJson("/command", {
      type: "run.location-updated", runId, latitude: 6.4541, longitude: 3.3947, observedAt: Date.now(),
    });
    expect(location.status).toBe(200);

    const final = await postJson(`/runs/${runId}/delivery/final`, {});
    expect(final.status).toBe(200);
    expect(((await readJson(final)).run as { status: string }).status).toBe("delivered");

    // Dispute window lapses → the settlement function releases with the run's
    // actual legs and the durable identities from checkout.
    const stub = runStub(runId);
    await shiftTime(stub, 31 * 60 * 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const released = await waitFor("settlement.released");
    expect(released.mode).toBe("completed");
    expect(released.buyerId).toBe("buyer:e2e");
    expect(released.runnerId).toBe("runner:internal");
    expect(released.sellers).toEqual([{ sellerId: "Amina's Fresh Store", amountKobo: 160_000 }]);
    expect(released.runnerKobo).toBe(170_000);
    expect(released.platformKobo).toBe(26_000); // 10% of 160_000 + 10_000 margin
    expect(released.buyerRefundKobo).toBe(0);
    expect(released.inputs).toMatchObject({
      mode: "completed",
      sellers: [{ sellerId: "Amina's Fresh Store", amountKobo: 160_000, stopCompleted: true }],
    });

    const retired = await waitFor("run.retired");
    expect(retired.mode).toBe("completed");
    expect(retired.buyerId).toBe("buyer:e2e");
    expect(retired.status).toBe("closed");

    // The run is retired: storage gone, ops view empty.
    expect((await getJson(`/ops/api/runs/${runId}`)).status).toBe(200);
    const after = await readJson(await getJson(`/ops/api/runs/${runId}`));
    expect(after.run).toBeNull();
  });

  it("ops console settles an open run as aborted — never a full refund (ADR-0008)", async () => {
    const { runId } = await driveToRun("e2eb", "buyer:e2eb");
    const { waitFor } = await attachRunSocket(runId);

    const settle = await postJson(`/ops/api/runs/${runId}/settle`, {
      mode: "aborted", reason: "runner breakdown before pickup",
    });
    expect(settle.status).toBe(200);
    const adjustment = await readJson(settle);
    expect(adjustment.adjusted).toBe(true);
    expect(adjustment.reason).toBe("runner breakdown before pickup");

    const settlement = adjustment.settlement as Record<string, unknown>;
    expect(settlement.mode).toBe("aborted");
    expect(settlement.buyerId).toBe("buyer:e2eb");
    // Capture: goods 160_000 + delivery 170_000 + margin 10_000 = 340_000.
    // Runner disruption 25% of delivery = 42_500; platform fee 10% = 17_000.
    expect(settlement.runnerKobo).toBe(42_500);
    expect(settlement.platformKobo).toBe(17_000);
    expect(settlement.buyerRefundKobo).toBe(280_500); // 340_000 − 42_500 − 17_000
    // ADR-0008: the buyer is not made whole — the refund alone is less than
    // the capture, and the runner/platform keep their disruption/fee shares.
    expect(settlement.buyerRefundKobo as number).toBeLessThan(340_000);
    expect((settlement.runnerKobo as number) + (settlement.platformKobo as number)).toBeGreaterThan(0);
    expect((settlement.inputs as { abortSplit: unknown }).abortSplit).toBeDefined();

    const released = await waitFor("settlement.released");
    expect(released.mode).toBe("aborted");
    const retired = await waitFor("run.retired");
    expect(retired.status).toBe("aborted");

    // Settling again is refused; the run is gone.
    const again = await postJson(`/ops/api/runs/${runId}/settle`, { mode: "completed" });
    expect(again.status).toBe(404);
  });

  it("ops settle validates its body and 404s unknown runs", async () => {
    const bad = await postJson(`/ops/api/runs/run:cart:nope/settle`, { mode: "sideways" });
    expect(bad.status).toBe(400);
    const missing = await postJson(`/ops/api/runs/run:cart:nope/settle`, { mode: "completed" });
    expect(missing.status).toBe(404);
  });

  it("serves the ops console HTML and the reputation proxy failure clearly", async () => {
    const page = await getJson("/ops");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Ops Console");

    // With no archive service reachable this is a clear 503; in a dev
    // environment where one happens to be running (OPS_ARCHIVE_URL is a
    // wrangler var) the proxy returns the computed reputation instead.
    const reputation = await getJson("/ops/api/reputation?participant=buyer:x&role=buyer");
    const reputationBody = await readJson(reputation);
    if (reputation.status === 503) {
      expect(reputationBody.error).toBe("archive-unavailable");
    } else {
      expect(reputation.status).toBe(200);
      expect(reputationBody.participantId).toBe("buyer:x");
    }
  });
});

describe("buyer product discovery", () => {
  it("indexes offered products under their intent for the buyer app", async () => {
    const posted = await postJson("/command", {
      type: "intent.posted", intentId: "disc-intent-1", shopItem: "Tomatoes", quantity: 2, unit: "kg",
      priceBand: { minKobo: 120_000, maxKobo: 180_000 }, market: "disc",
    });
    expect(posted.status).toBe(200);
    const offered = await postJson(`/markets/disc/offers`, {
      productId: "disc-product-1", intentId: "disc-intent-1", market: "disc", shopItem: "Tomatoes",
      quantity: 2, unit: "kg", priceKobo: 165_000, sellerName: "Amina's Fresh Store", exchangePoint: "disc Market, Stall B14",
    });
    expect(offered.status).toBe(200);

    const discovery = await getJson("/markets/disc/intents/disc-intent-1/products");
    const body = await readJson(discovery);
    expect(body.productIds).toEqual(["disc-product-1"]);

    const product = await readJson(await getJson("/products/disc-product-1"));
    expect(product.product.priceKobo).toBe(165_000);
  });
});
