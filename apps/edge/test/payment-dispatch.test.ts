import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { PaymentDispatchRequestedSchema } from "@market-runs/proto";
import {
  acceptProduct,
  bindings,
  checkout,
  internalPost,
  offerProduct,
  postIntent,
  readJson,
  runStub,
  shiftTime,
} from "./helpers.js";

/**
 * Settlement release emits payment.dispatch-requested on the payment queue:
 * the settlement function decided the splits (ADR-0007/0008), and the edge
 * hands the computed legs to the payment-dispatch consumer for execution
 * (ADR-0009 vendor-neutral dispatcher). The queue send is fire-and-forget in
 * the same release path as the archive sendBatch.
 */
describe("payment dispatch emission on settlement release", () => {
  it("dispute-window release emits the computed payout legs with the settlement idempotency key", async () => {
    const sendSpy = vi.spyOn(bindings.PAYMENT_QUEUE, "send");

    expect((await postIntent("pd-intent-1", "pd")).status).toBe(200);
    expect((await offerProduct("pd-product-1", "pd-intent-1", "pd")).status).toBe(200); // 165_000 kobo goods
    expect((await acceptProduct("pd-product-1")).status).toBe(200);

    const accepted = await checkout("cart:pd:buyer:anonymous");
    expect(accepted.status).toBe(200);
    const checkoutEvent = await readJson(accepted);
    const runId = String(checkoutEvent.runId);
    expect(runId).toBe("run:cart:pd:buyer:anonymous");
    const floorRateKobo = Number(checkoutEvent.floorRateKobo);
    expect(floorRateKobo).toBe(170_000);

    const stub = runStub(runId);

    const initiate = await stub.fetch(
      internalPost("/handoff/initiate", {
        handoffId: "pd-handoff-1",
        exchangePointId: "pd Market, Stall B14",
        counterparty: "Amina's Fresh Store",
      }),
    );
    expect(initiate.status).toBe(200);
    const photo = await stub.fetch(
      internalPost("/handoff/photo", {
        type: "handoff.photo-captured",
        handoffId: "pd-handoff-1",
        photoCaptureRef: "r2://archive/captures/pd-handoff-1.jpg",
        capturedAt: Date.now(),
      }),
    );
    expect(photo.status).toBe(200);
    const scan = await stub.fetch(
      internalPost("/handoff/scan", {
        type: "handoff.challenge-scanned",
        handoffId: "pd-handoff-1",
        runId,
        scannedAt: Date.now(),
      }),
    );
    expect(scan.status).toBe(200);

    const final = await stub.fetch(internalPost("/delivery/final", {}));
    expect(final.status).toBe(200);

    // Dispute window lapses → settle() runs → release path emits the dispatch request.
    await shiftTime(stub, 31 * 60 * 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const dispatched = sendSpy.mock.calls
      .map(([body]) => PaymentDispatchRequestedSchema.safeParse(typeof body === "string" ? JSON.parse(body) : body))
      .find((parsed) => parsed.success);
    expect(dispatched?.success).toBe(true);
    if (dispatched?.success) {
      expect(dispatched.data).toMatchObject({
        type: "payment.dispatch-requested",
        settlementRecordId: "run:cart:pd:buyer:anonymous:settlement",
        runId,
        market: "pd",
        // One settlement = one dispatch request: replay is the consumer's job to collapse.
        idempotencyKey: "settlement:run:cart:pd:buyer:anonymous:settlement",
      });
      // Legs mirror the settlement record exactly — seller payout, runner
      // payout, platform commission (ADR-0005) — no recomputation at dispatch.
      expect(dispatched.data.legs).toEqual([
        { account: "seller", partyId: "Amina's Fresh Store", amountKobo: 165_000, memo: "Seller settlement" },
        { account: "runner", partyId: "runner:internal", amountKobo: 170_000, memo: "Runner settlement" },
        { account: "platform", partyId: "platform", amountKobo: 26_500, memo: "Platform settlement" },
      ]);
    }
    sendSpy.mockRestore();
  });
});
