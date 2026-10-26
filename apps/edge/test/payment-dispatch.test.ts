import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { PaymentDispatchRequestedSchema } from "@market-runs/proto";
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

describe("payment dispatch emission on settlement release", () => {
  it("emits the computed payout legs with the settlement idempotency key", async () => {
    const sendSpy = vi.spyOn(bindings.PAYMENT_QUEUE, "send");
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
    const dispatched = sendSpy.mock.calls
      .map(([body]) => PaymentDispatchRequestedSchema.safeParse(typeof body === "string" ? JSON.parse(body) : body))
      .find((parsed) => parsed.success);
    expect(dispatched?.success).toBe(true);
    if (dispatched?.success) {
      expect(dispatched.data).toMatchObject({
        type: "payment.dispatch-requested",
        settlementRecordId: `${runId}:settlement`,
        runId,
        market: "pd",
        idempotencyKey: `settlement:${runId}:settlement`,
      });
      expect(dispatched.data.legs).toEqual([
        { account: "seller", partyId: "seller:handoff", amountKobo: 148_500, memo: "Seller settlement" },
        { account: "runner", partyId: RUNNER, amountKobo: 160_000, memo: "Runner settlement" },
        { account: "platform", partyId: "platform", amountKobo: 26_500, memo: "Platform settlement" },
      ]);
    }
    sendSpy.mockRestore();
  });
});
