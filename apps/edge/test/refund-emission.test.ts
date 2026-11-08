import { describe, expect, it, vi } from "vitest";
import { SettlementReleasedSchema } from "@market-runs/proto";
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

/** The archive carries the buyer-refund decision; the edge no longer emits payment execution requests. */
describe("buyer refund archive emission", () => {
  it("ops abort archives the canonical refund outcome without using the legacy payment queue", async () => {
    const paymentQueue = (bindings as unknown as { PAYMENT_QUEUE?: Queue }).PAYMENT_QUEUE;
    const paymentSendSpy = paymentQueue ? vi.spyOn(paymentQueue, "send") : undefined;
    const archiveBatchSpy = vi.spyOn(bindings.ARCHIVE_QUEUE, "sendBatch");
    try {
      expect((await postIntent("pr-intent-1", "pr")).status).toBe(200);
      expect((await offerProduct("pr-product-1", "pr-intent-1", "pr")).status).toBe(200); // 165_000 kobo goods
      expect((await acceptProduct("pr-product-1")).status).toBe(200);

      const accepted = await checkout("cart:pr:buyer:anonymous");
      expect(accepted.status).toBe(200);
      const runId = String((await readJson(accepted)).runId);
      expect(runId).toBe("run:cart:pr:buyer:anonymous");

      // Abort before any handoff: goods + delivery minus the canonical abort split.
      const settled = await runStub(runId).fetch(internalPost("/ops/settle", { mode: "aborted", reason: "test abort" }));
      expect(settled.status).toBe(200);

      expect(paymentSendSpy?.mock.calls ?? []).toHaveLength(0);
      const released = archiveBatchSpy.mock.calls
        .flatMap(([messages]) => messages)
        .map(({ body }) => SettlementReleasedSchema.safeParse(typeof body === "string" ? JSON.parse(body) : body))
        .find((parsed) => parsed.success);
      expect(released?.success).toBe(true);
      if (released?.success) {
        expect(released.data).toMatchObject({
          type: "settlement.released",
          runId,
          buyerId: "buyer:anonymous",
          runnerId: "runner:internal",
          mode: "aborted",
          sellers: [{ sellerId: "Amina's Fresh Store", amountKobo: 0 }],
          runnerKobo: 32_500,
          platformKobo: 27_000,
          buyerRefundKobo: 275_500,
          platformLossKobo: 0,
          inputs: {
            mode: "aborted",
            sellers: [{ sellerId: "Amina's Fresh Store", amountKobo: 165_000, stopCompleted: false }],
            deliveryPriceKobo: 170_000,
            deliveryMarginKobo: 10_000,
            goodsCommissionBps: 1_000,
            abortSplit: { disruptionCompensationBps: 2_500, platformFeeBps: 1_000, ambiguousLossCapKobo: 5_000 },
          },
        });
        // Abort doctrine: never a full refund (335_000 = goods + delivery).
        expect(released.data.buyerRefundKobo).toBeLessThan(335_000);
      }
    } finally {
      paymentSendSpy?.mockRestore();
      archiveBatchSpy.mockRestore();
    }
  });

  it("a completed run archives zero buyer refund and does not use the legacy payment queue", async () => {
    const paymentQueue = (bindings as unknown as { PAYMENT_QUEUE?: Queue }).PAYMENT_QUEUE;
    const paymentSendSpy = paymentQueue ? vi.spyOn(paymentQueue, "send") : undefined;
    const archiveBatchSpy = vi.spyOn(bindings.ARCHIVE_QUEUE, "sendBatch");
    try {
      expect((await postIntent("pr-intent-2", "pr")).status).toBe(200);
      expect((await offerProduct("pr-product-2", "pr-intent-2", "pr")).status).toBe(200);
      expect((await acceptProduct("pr-product-2")).status).toBe(200);
      const accepted = await checkout("cart:pr:buyer:anonymous");
      expect(accepted.status).toBe(200);
      const runId = String((await readJson(accepted)).runId);

      const settled = await runStub(runId).fetch(internalPost("/ops/settle", { mode: "completed", reason: "test" }));
      expect(settled.status).toBe(200);

      expect(paymentSendSpy?.mock.calls ?? []).toHaveLength(0);
      const released = archiveBatchSpy.mock.calls
        .flatMap(([messages]) => messages)
        .map(({ body }) => SettlementReleasedSchema.safeParse(typeof body === "string" ? JSON.parse(body) : body))
        .find((parsed) => parsed.success);
      expect(released?.success).toBe(true);
      if (released?.success) expect(released.data.buyerRefundKobo).toBe(0);
    } finally {
      paymentSendSpy?.mockRestore();
      archiveBatchSpy.mockRestore();
    }
  });
});
