import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  acceptProduct,
  checkout,
  internalPost,
  offerProduct,
  postIntent,
  readJson,
  runStub,
  shiftTime,
} from "./helpers.js";

async function waitForEvent(
  events: Array<Record<string, unknown>>,
  type: string,
  attempts = 40,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < attempts; i += 1) {
    const found = events.find((event) => event.type === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`event ${type} never arrived; saw ${JSON.stringify(events.map((e) => e.type))}`);
}

/**
 * The full close pipeline: checkout seeds the Run, handoffs confirm the stop,
 * final delivery stamps the run and arms the dispute window, and when the
 * window lapses with no dispute the domain settle() releases through the
 * archive queue and the run retires.
 */
describe("RunDO settlement trigger", () => {
  it("checkout → handoff → final delivery → dispute window → settlement.released", async () => {
    expect((await postIntent("st-intent-1", "st")).status).toBe(200);
    expect((await offerProduct("st-product-1", "st-intent-1", "st")).status).toBe(200); // 165_000 kobo goods
    expect((await acceptProduct("st-product-1")).status).toBe(200);

    const accepted = await checkout("cart:st:buyer:anonymous");
    expect(accepted.status).toBe(200);
    const checkoutEvent = await readJson(accepted);
    expect(checkoutEvent.type).toBe("checkout.accepted");
    const runId = String(checkoutEvent.runId);
    expect(runId).toBe("run:cart:st:buyer:anonymous");
    const floorRateKobo = Number(checkoutEvent.floorRateKobo);
    expect(floorRateKobo).toBe(170_000);

    const stub = runStub(runId);

    // Observe broadcasts on a hibernated socket attached to the Run.
    const upgrade = await stub.fetch(
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

    const initiate = await stub.fetch(
      internalPost("/handoff/initiate", {
        handoffId: "handoff-1",
        exchangePointId: "st Market, Stall B14",
        counterparty: "Amina's Fresh Store",
      }),
    );
    expect(initiate.status).toBe(200);

    // Photo evidence is accepted as an R2 key reference; only the ref is stored.
    const photo = await stub.fetch(
      internalPost("/handoff/photo", {
        type: "handoff.photo-captured",
        handoffId: "handoff-1",
        photoCaptureRef: "r2://archive/captures/handoff-1.jpg",
        capturedAt: Date.now(),
      }),
    );
    expect(photo.status).toBe(200);

    // The runner scans the one-time challenge → explicit confirm.
    const scan = await stub.fetch(
      internalPost("/handoff/scan", {
        type: "handoff.challenge-scanned",
        handoffId: "handoff-1",
        runId,
        scannedAt: Date.now(),
      }),
    );
    expect(scan.status).toBe(200);
    const confirmed = await readJson(scan);
    expect(confirmed.type).toBe("handoff.confirmed");

    const runView = await stub.fetch(new Request("http://do/"));
    const run = (await readJson(runView)).run as { status: string; stops: Array<{ status: string }> };
    expect(run.stops[0]?.status).toBe("completed");
    expect(run.status).toBe("delivering");

    // Final delivery: stamp and arm the dispute window.
    const final = await stub.fetch(internalPost("/delivery/final", {}));
    expect(final.status).toBe(200);
    expect(((await readJson(final)).run as { status: string }).status).toBe("delivered");

    // Dispute window lapses with no dispute → settle() with the actual legs.
    await shiftTime(stub, 31 * 60 * 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const released = await waitForEvent(events, "settlement.released");
    expect(released.mode).toBe("completed");
    expect(released.runId).toBe(runId);
    expect(released.sellers).toEqual([{ sellerId: "Amina's Fresh Store", amountKobo: 148_500 }]);
    expect(released.runnerKobo).toBe(floorRateKobo - 10_000);
    expect(released.platformKobo).toBe(26_500); // 10% seller commission + 10_000 runner margin deduction
    expect(released.buyerRefundKobo).toBe(0);
    expect(released.platformLossKobo).toBe(0);

    // The run retired: settlement + snapshot went to the archive queue and storage is gone.
    const viewAfter = await stub.fetch(new Request("http://do/"));
    expect(viewAfter.status).toBe(404);
  });
});
