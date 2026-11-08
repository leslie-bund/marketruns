import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SettlementReleasedSchema } from "@market-runs/proto";
import { bindings, runStub, shiftTime } from "./helpers.js";
import {
  RUNNER,
  completePickup,
  confirm,
  driveToRun,
  identity,
  openDelivery,
  photo,
  postJson,
  scan,
} from "./handoff-helpers.js";

describe("settlement archive emission", () => {
  it("archives the canonical payout outcome without using the legacy payment queue", async () => {
    const paymentQueue = (bindings as unknown as { PAYMENT_QUEUE?: Queue }).PAYMENT_QUEUE;
    const paymentSendSpy = paymentQueue ? vi.spyOn(paymentQueue, "send") : undefined;
    const archiveBatchSpy = vi.spyOn(bindings.ARCHIVE_QUEUE, "sendBatch");
    try {
      const buyerId = "buyer:pd";
      const { runId, code } = await driveToRun("pd", buyerId, { kind: "designated", name: "Receiver" });
      await completePickup(runId, "pd");
      await openDelivery(runId, buyerId, "pd-delivery", "Receiver");
      await scan(runId, "pd-delivery", code);
      await photo(runId, "pd-delivery");
      await confirm(runId, "pd-delivery");
      expect((await postJson(`/runs/${runId}/delivery/final`, {}, identity(RUNNER, "runner"))).status).toBe(200);

      await shiftTime(runStub(runId), 31 * 60 * 1000);
      expect(await runDurableObjectAlarm(runStub(runId))).toBe(true);

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
          buyerId,
          runnerId: RUNNER,
          mode: "completed",
          sellers: [{ sellerId: "seller:handoff", amountKobo: 148_500 }],
          runnerKobo: 160_000,
          platformKobo: 26_500,
          buyerRefundKobo: 0,
          platformLossKobo: 0,
          inputs: {
            mode: "completed",
            sellers: [{ sellerId: "seller:handoff", amountKobo: 165_000, stopCompleted: true }],
            deliveryPriceKobo: 170_000,
            deliveryMarginKobo: 10_000,
            goodsCommissionBps: 1_000,
          },
        });
        expect(released.data.releasedAt).toBeGreaterThan(0);
      }
    } finally {
      paymentSendSpy?.mockRestore();
      archiveBatchSpy.mockRestore();
    }
  });
});
