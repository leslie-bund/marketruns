import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readJson, runStub, shiftTime } from "./helpers.js";
import {
  completePickup,
  confirm,
  driveToRun,
  identity,
  openDelivery,
  photo,
  postJson,
  scan,
} from "./handoff-helpers.js";
import { RUNNER } from "./handoff-helpers.js";

async function waitForEvent(events: Array<Record<string, unknown>>, type: string, attempts = 40): Promise<Record<string, unknown>> {
  for (let i = 0; i < attempts; i += 1) {
    const found = events.find((event) => event.type === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`event ${type} never arrived; saw ${JSON.stringify(events.map((event) => event.type))}`);
}

describe("RunDO settlement trigger", () => {
  it("checkout → verified handoffs → final delivery → dispute window → settlement.released", async () => {
    const buyerId = "buyer:st";
    const { runId, code } = await driveToRun("st", buyerId, { kind: "designated", name: "Receiver" });
    const floorRateKobo = 170_000;
    const stub = runStub(runId);
    const upgrade = await stub.fetch(new Request("http://do/ws", { headers: { upgrade: "websocket" } }));
    expect(upgrade.status).toBe(101);
    const ws = upgrade.webSocket;
    if (!ws) throw new Error("no client socket");
    ws.accept();
    const events: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (event) => events.push(JSON.parse(String(event.data)) as Record<string, unknown>));

    await completePickup(runId, "st");
    await openDelivery(runId, buyerId, "st-delivery", "Receiver");
    await scan(runId, "st-delivery", code);
    await photo(runId, "st-delivery");
    expect((await confirm(runId, "st-delivery")).status).toBe(200);
    const final = await postJson(`/runs/${runId}/delivery/final`, {}, identity(RUNNER, "runner"));
    expect(final.status).toBe(200);
    expect(((await readJson(final)).run as { status: string }).status).toBe("delivered");

    await shiftTime(stub, 31 * 60 * 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const released = await waitForEvent(events, "settlement.released");
    expect(released.mode).toBe("completed");
    expect(released.runId).toBe(runId);
    expect(released.sellers).toEqual([{ sellerId: "seller:handoff", amountKobo: 148_500 }]);
    expect(released.runnerKobo).toBe(floorRateKobo - 10_000);
    expect(released.platformKobo).toBe(26_500);
    expect(released.buyerRefundKobo).toBe(0);
    expect(released.platformLossKobo).toBe(0);
    expect((await stub.fetch(new Request("http://do/"))).status).toBe(404);
  });
});
