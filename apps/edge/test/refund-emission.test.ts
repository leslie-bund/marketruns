import { describe, expect, it, vi } from "vitest";
import { PaymentRefundRequestedSchema } from "@market-runs/proto";
import {
  acceptProduct,
  bindings,
  checkout,
  internalPost,
  offerProduct,
  postIntent,
  readJson,
  runStub,
} from "./helpers.js";

/**
 * Settlement release emits payment.refund-requested when the outcome carries
 * buyerRefundKobo > 0 (here: an ops abort, ADR-0008 — never a full refund).
 * The refund rides the same payment queue as dispatch-requested and releases
 * against the buyer's hold at the payments worker (ADR-0023).
 */
describe("payment refund emission on settlement release", () => {
  it("ops abort emits payment.refund-requested with the settlement idempotency key", async () => {
    const sendSpy = vi.spyOn(bindings.PAYMENT_QUEUE, "send");

    expect((await postIntent("pr-intent-1", "pr")).status).toBe(200);
    expect((await offerProduct("pr-product-1", "pr-intent-1", "pr")).status).toBe(200); // 165_000 kobo goods
    expect((await acceptProduct("pr-product-1")).status).toBe(200);

    const accepted = await checkout("cart:pr:buyer:anonymous");
    expect(accepted.status).toBe(200);
    const runId = String((await readJson(accepted)).runId);
    expect(runId).toBe("run:cart:pr:buyer:anonymous");

    // Ops settle-only adjustment: abort before any handoff — the buyer is
    // refunded goods + delivery minus the abort split (ADR-0008).
    const settled = await runStub(runId).fetch(internalPost("/ops/settle", { mode: "aborted", reason: "test abort" }));
    expect(settled.status).toBe(200);

    const refund = sendSpy.mock.calls
      .map(([body]) => PaymentRefundRequestedSchema.safeParse(typeof body === "string" ? JSON.parse(body) : body))
      .find((parsed) => parsed.success);
    expect(refund?.success).toBe(true);
    if (refund?.success) {
      expect(refund.data).toMatchObject({
        type: "payment.refund-requested",
        settlementRecordId: "run:cart:pr:buyer:anonymous:settlement",
        runId,
        buyerId: "buyer:anonymous",
        idempotencyKey: "refund:run:cart:pr:buyer:anonymous:settlement",
      });
      expect(refund.data.amountKobo).toBeGreaterThan(0);
      // Abort doctrine: never a full refund (335_000 = goods + delivery).
      expect(refund.data.amountKobo).toBeLessThan(335_000);
    }
    sendSpy.mockRestore();
  });

  it("a completed run (no buyer refund) emits no refund request", async () => {
    const sendSpy = vi.spyOn(bindings.PAYMENT_QUEUE, "send");

    expect((await postIntent("pr-intent-2", "pr")).status).toBe(200);
    expect((await offerProduct("pr-product-2", "pr-intent-2", "pr")).status).toBe(200);
    expect((await acceptProduct("pr-product-2")).status).toBe(200);
    const accepted = await checkout("cart:pr:buyer:anonymous");
    expect(accepted.status).toBe(200);
    const runId = String((await readJson(accepted)).runId);

    const settled = await runStub(runId).fetch(internalPost("/ops/settle", { mode: "completed", reason: "test" }));
    expect(settled.status).toBe(200);

    const refund = sendSpy.mock.calls
      .map(([body]) => PaymentRefundRequestedSchema.safeParse(typeof body === "string" ? JSON.parse(body) : body))
      .find((parsed) => parsed.success);
    expect(refund).toBeUndefined();
    sendSpy.mockRestore();
  });
});
