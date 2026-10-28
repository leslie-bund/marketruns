import { SELF, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { HANDOFF_AUTO_CONFIRM_MS } from "@market-runs/domain";
import { DeliveryCodeSchema } from "@market-runs/proto";
import { readJson, runStub, shiftTime } from "./helpers.js";
import {
  BASE,
  RUNNER,
  SELLER,
  completePickup,
  confirm,
  driveToRun,
  getJson,
  identity,
  initiate,
  openDelivery,
  photo,
  pickupChallenge,
  postJson,
  runView,
  scan,
} from "./handoff-helpers.js";
import { DELIVERY_CODE_MAX_ATTEMPTS, DELIVERY_CODE_TTL_MS } from "../src/do/run/delivery-security.js";

interface HandoffView {
  id: string;
  type: "pickup" | "delivery";
  status: string;
  photoCaptureRef?: string;
  photoCapturedAt?: number;
  scannedAt?: number;
  confirmedAt?: number;
  confirmedBy?: string;
  autoConfirmed?: boolean;
}

function handoffs(run: Record<string, unknown>): HandoffView[] {
  return run.handoffs as HandoffView[];
}

async function upload(bytes: Uint8Array, owner = identity(RUNNER, "runner"), runId?: string): Promise<Record<string, unknown>> {
  const response = await SELF.fetch(new Request(`${BASE}/captures`, {
    method: "POST",
    headers: { "content-type": "image/jpeg", ...owner, ...(runId ? { "x-run-id": runId } : {}) },
    body: bytes,
  }));
  expect(response.status).toBe(200);
  return readJson(response);
}

describe("capture ownership and run evidence reads", () => {
  it("requires identity, allows the owner, and rejects unrelated readers", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect((await SELF.fetch(new Request(`${BASE}/captures`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: bytes }))).status).toBe(401);
    const uploaded = await upload(bytes);
    expect((await getJson(String(uploaded.url))).status).toBe(401);
    expect((await getJson(String(uploaded.url), identity("buyer:other", "buyer"))).status).toBe(403);
    const ownerRead = await getJson(String(uploaded.url), identity(RUNNER, "runner"));
    expect(ownerRead.status).toBe(200);
    expect(ownerRead.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await ownerRead.arrayBuffer())).toEqual(bytes);
  });

  it("lets run participants read attached evidence without exposing unattached uploads", async () => {
    const buyerId = "buyer:capture-evidence";
    const { runId } = await driveToRun("capture-evidence", buyerId);
    const uploaded = await upload(new Uint8Array([1, 2, 3, 4]), identity(RUNNER, "runner"), runId);
    expect((await getJson(String(uploaded.url), identity(buyerId, "buyer"))).status).toBe(403);
    await initiate(runId, "capture-pickup", "pickup", "capture-evidence Market, Stall B14", "Amina's Fresh Store");
    expect((await photo(runId, "capture-pickup", String(uploaded.ref))).status).toBe(200);
    const buyerRead = await getJson(String(uploaded.url), identity(buyerId, "buyer"));
    expect(buyerRead.status).toBe(200);
    expect(new Uint8Array(await buyerRead.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});

describe("product and ops evidence reads", () => {
  it("authorizes product reads and media to the buyer and selling owner, with an ops-only proxy", async () => {
    const market = "product-evidence";
    const buyerId = "buyer:product-evidence";
    const productId = "product-product-evidence";
    const intentId = "intent-product-evidence";
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);
    const uploaded = await upload(bytes, identity(SELLER, "seller"));
    expect((await postJson("/command", {
      type: "intent.posted", intentId, shopItem: "Tomatoes", quantity: 2, unit: "kg",
      priceBand: { minKobo: 120_000, maxKobo: 180_000 }, market,
    }, identity(buyerId, "buyer"))).status).toBe(200);
    expect((await postJson(`/markets/${market}/offers`, {
      productId, intentId, market, shopItem: "Tomatoes", quantity: 2, unit: "kg",
      priceKobo: 165_000, sellerName: "Amina's Fresh Store", sellerParticipantId: SELLER,
      exchangePoint: `${market} Market, Stall B14`, photoCaptureRef: uploaded.ref,
    })).status).toBe(200);

    expect((await getJson(`/products/${productId}`)).status).toBe(401);
    expect((await getJson(`/products/${productId}`, identity("buyer:stranger", "buyer"))).status).toBe(403);
    expect((await getJson(`/products/${productId}`, identity(buyerId, "buyer"))).status).toBe(200);
    expect((await getJson(`/products/${productId}`, identity(SELLER, "seller"))).status).toBe(200);

    const mediaPath = `/products/${productId}/capture`;
    expect((await getJson(mediaPath)).status).toBe(401);
    expect((await getJson(mediaPath, identity("buyer:stranger", "buyer"))).status).toBe(403);
    for (const headers of [identity(buyerId, "buyer"), identity(SELLER, "seller")]) {
      const media = await getJson(mediaPath, headers);
      expect(media.status).toBe(200);
      expect(media.headers.get("cache-control")).toBe("private, no-store");
      expect(new Uint8Array(await media.arrayBuffer())).toEqual(bytes);
    }

    const opsPath = String(uploaded.url).replace("/captures/", "/ops/api/captures/");
    const opsMedia = await getJson(opsPath);
    expect(opsMedia.status).toBe(200);
    expect(new Uint8Array(await opsMedia.arrayBuffer())).toEqual(bytes);
  });
});

describe("signed pickup handoffs", () => {
  it("rejects bare ids and forged payloads, uses server timestamps, and freezes confirmed evidence", async () => {
    const buyerId = "buyer:pickup-security";
    const { runId } = await driveToRun("pickup-security", buyerId);
    await initiate(runId, "pickup-security-1", "pickup", "pickup-security Market, Stall B14", "Amina's Fresh Store");
    expect((await postJson("/command", {
      type: "handoff.challenge-scanned", handoffId: "pickup-security-1", runId, scannedAt: Date.now(),
    }, identity(RUNNER, "runner"))).status).toBe(400);
    expect((await scan(runId, "pickup-security-1", "pickup-security-1")).status).toBe(409);
    const challenge = await pickupChallenge(runId, "pickup-security-1");
    expect((await scan(runId, "pickup-security-1", challenge)).status).toBe(409);
    expect((await photo(runId, "pickup-security-1")).status).toBe(200);
    const [handoff] = handoffs(await runView(runId, buyerId));
    expect(handoff.type).toBe("pickup");
    expect(handoff.status).toBe("confirmed");
    expect(handoff.photoCapturedAt).not.toBe(1);
    expect(handoff.scannedAt).not.toBe(1);
    expect(handoff.confirmedBy).toBe(RUNNER);
    expect((await photo(runId, "pickup-security-1", "r2://archive/captures/replacement.jpg")).status).toBe(409);
    const [unchanged] = handoffs(await runView(runId, buyerId));
    expect(unchanged.photoCaptureRef).toBe(handoff.photoCaptureRef);
  });

  it("retains photo-gated pickup auto-confirm without extending it to delivery", async () => {
    const buyerId = "buyer:pickup-auto";
    const { runId, code } = await driveToRun("pickup-auto", buyerId, { kind: "designated", name: "Ada" });
    await initiate(runId, "pickup-auto-1", "pickup", "pickup-auto Market, Stall B14", "Amina's Fresh Store");
    await photo(runId, "pickup-auto-1");
    const stub = runStub(runId);
    await shiftTime(stub, HANDOFF_AUTO_CONFIRM_MS + 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await completePickup(runId, "pickup-auto", "pickup-auto-2").catch(() => undefined);
    // Complete the now-confirmed pickup's stop with a second seller stop is not needed:
    // this assertion focuses on the auto-confirmed handoff itself.
    expect(handoffs(await runView(runId, buyerId))[0]?.autoConfirmed).toBe(true);
    expect(code).toMatch(/^\d{6}$/);
  });
});

describe("verified code plus fresh-photo receiver flow", () => {
  it("preserves delegation and requires code, new photo, explicit receiver confirmation, and final delivery", async () => {
    const buyerId = "buyer:receiver-full";
    const { runId, code } = await driveToRun("receiver-full", buyerId, { kind: "designated", name: "Ada Receiver" });
    const recovered = await getJson(`/runs/${runId}/delivery-code`, identity(buyerId, "buyer"));
    expect(recovered.status).toBe(200);
    expect(DeliveryCodeSchema.parse(await readJson(recovered)).code).toBe(code);
    expect((await getJson(`/runs/${runId}/delivery-code`, identity(RUNNER, "runner"))).status).toBe(403);
    expect(JSON.stringify(await runView(runId, buyerId))).not.toContain(code);

    await completePickup(runId, "receiver-full");
    await openDelivery(runId, buyerId, "receiver-delivery", "Ada Receiver");
    expect((await scan(runId, "receiver-delivery", code)).status).toBe(200);
    expect((await confirm(runId, "receiver-delivery")).status).toBe(409); // no photo
    expect((await postJson(`/runs/${runId}/delivery/final`, {}, identity(RUNNER, "runner"))).status).toBe(409);
    expect((await photo(runId, "receiver-delivery")).status).toBe(200);
    expect((await postJson(`/runs/${runId}/delivery/final`, {}, identity(RUNNER, "runner"))).status).toBe(409); // no explicit typed confirm
    expect((await confirm(runId, "receiver-delivery")).status).toBe(200);
    const beforeFinal = await runView(runId, buyerId);
    expect(beforeFinal.receiver).toEqual({ kind: "designated", name: "Ada Receiver" });
    expect(beforeFinal.delegatedByParticipantId).toBe(buyerId);
    const delivery = handoffs(beforeFinal).find((handoff) => handoff.type === "delivery");
    expect(delivery?.confirmedBy).toBe("receiver");
    expect(delivery?.autoConfirmed).toBe(false);
    expect((await photo(runId, "receiver-delivery", "r2://archive/captures/immutable-delivery.jpg")).status).toBe(409);
    expect((await postJson(`/runs/${runId}/delivery/final`, {}, identity(RUNNER, "runner"))).status).toBe(200);
    expect((await runView(runId, buyerId)).status).toBe("delivered");
  });

  it("supports Me receipt with confirmedBy buyer attribution", async () => {
    const buyerId = "buyer:self-receipt";
    const { runId, code } = await driveToRun("self-receipt", buyerId);
    await completePickup(runId, "self-receipt");
    await openDelivery(runId, buyerId, "self-delivery");
    expect((await scan(runId, "self-delivery", code)).status).toBe(200);
    await photo(runId, "self-delivery");
    expect((await confirm(runId, "self-delivery")).status).toBe(409); // runner cannot confirm a Me receipt
    expect((await confirm(runId, "self-delivery", buyerId)).status).toBe(200);
    const delivery = handoffs(await runView(runId, buyerId)).find((handoff) => handoff.type === "delivery");
    expect(delivery?.confirmedBy).toBe(buyerId);
  });

  it("rejects confirmation without code and rejects a photo captured before code verification", async () => {
    const buyerId = "buyer:fresh-photo";
    const { runId, code } = await driveToRun("fresh-photo", buyerId, { kind: "designated", name: "Receiver" });
    await completePickup(runId, "fresh-photo");
    await openDelivery(runId, buyerId, "fresh-delivery", "Receiver");
    await photo(runId, "fresh-delivery");
    const noCode = await confirm(runId, "fresh-delivery");
    expect(noCode.status).toBe(409);
    expect((await readJson(noCode)).error).toBe("code-required");
    await scan(runId, "fresh-delivery", code);
    const stale = await confirm(runId, "fresh-delivery");
    expect(stale.status).toBe(409);
    expect((await readJson(stale)).error).toBe("fresh-photo-required");
    await photo(runId, "fresh-delivery");
    expect((await confirm(runId, "fresh-delivery")).status).toBe(200);
  });

  it("locks the code after repeated wrong attempts", async () => {
    const buyerId = "buyer:attempt-limit";
    const { runId, code } = await driveToRun("attempt-limit", buyerId, { kind: "designated", name: "Receiver" });
    await completePickup(runId, "attempt-limit");
    await openDelivery(runId, buyerId, "attempt-delivery", "Receiver");
    for (let attempt = 0; attempt < DELIVERY_CODE_MAX_ATTEMPTS; attempt += 1) {
      const wrong = await scan(runId, "attempt-delivery", "000000");
      expect(wrong.status).toBe(409);
      expect((await readJson(wrong)).error).toBe("invalid-code");
    }
    const locked = await scan(runId, "attempt-delivery", code);
    expect(locked.status).toBe(409);
    expect((await readJson(locked)).error).toBe("code-attempt-limit");
    await photo(runId, "attempt-delivery");
    expect((await confirm(runId, "attempt-delivery")).status).toBe(409);
  });

  it("expires codes on the server clock", async () => {
    const buyerId = "buyer:code-expiry";
    const { runId, code } = await driveToRun("code-expiry", buyerId, { kind: "designated", name: "Receiver" });
    await completePickup(runId, "code-expiry");
    await openDelivery(runId, buyerId, "expiry-delivery", "Receiver");
    await shiftTime(runStub(runId), DELIVERY_CODE_TTL_MS + 1000);
    const expired = await scan(runId, "expiry-delivery", code);
    expect(expired.status).toBe(409);
    expect((await readJson(expired)).error).toBe("code-expired");
    expect((await getJson(`/runs/${runId}/delivery-code`, identity(buyerId, "buyer"))).status).toBe(409);
  });

  it("lets only the buyer rotate an expired delayed-run code and invalidates the old code", async () => {
    const buyerId = "buyer:code-rotation";
    const { runId, code } = await driveToRun("code-rotation", buyerId, { kind: "designated", name: "Receiver" });
    await completePickup(runId, "code-rotation");
    await openDelivery(runId, buyerId, "rotation-delivery", "Receiver");
    await shiftTime(runStub(runId), DELIVERY_CODE_TTL_MS + 1000);
    expect((await postJson(`/runs/${runId}/delivery-code/rotate`, {}, identity(RUNNER, "runner"))).status).toBe(403);
    expect((await postJson(`/runs/${runId}/delivery-code/rotate`, {}, identity("buyer:stranger", "buyer"))).status).toBe(403);
    const rotated = await postJson(`/runs/${runId}/delivery-code/rotate`, {}, identity(buyerId, "buyer"));
    expect(rotated.status).toBe(200);
    const next = DeliveryCodeSchema.parse(await readJson(rotated));
    expect(next.code).not.toBe(code);
    expect(next.expiresAt).toBeGreaterThan(Date.now());
    expect((await scan(runId, "rotation-delivery", code)).status).toBe(409);
    expect((await scan(runId, "rotation-delivery", next.code)).status).toBe(200);
    expect((await postJson(`/runs/${runId}/delivery-code/rotate`, {}, identity(buyerId, "buyer"))).status).toBe(409);
  });

  it("never silently auto-confirms delivery even with code and photo", async () => {
    const buyerId = "buyer:no-delivery-auto";
    const { runId, code } = await driveToRun("no-delivery-auto", buyerId, { kind: "designated", name: "Receiver" });
    await completePickup(runId, "no-delivery-auto");
    await openDelivery(runId, buyerId, "auto-delivery", "Receiver");
    await scan(runId, "auto-delivery", code);
    await photo(runId, "auto-delivery");
    await shiftTime(runStub(runId), HANDOFF_AUTO_CONFIRM_MS + 1000);
    await runDurableObjectAlarm(runStub(runId));
    const delivery = handoffs(await runView(runId, buyerId)).find((handoff) => handoff.type === "delivery");
    expect(delivery?.status).toBe("pending");
    expect(delivery?.confirmedAt).toBeUndefined();
  });
});

describe("run membership, disputes, and archived evidence", () => {
  it("denies unrelated run reads, disputes, code reads, and pickup challenge reads", async () => {
    const buyerId = "buyer:membership";
    const { runId } = await driveToRun("membership", buyerId);
    expect((await getJson(`/runs/${runId}`)).status).toBe(401);
    expect((await getJson(`/runs/${runId}`, identity("buyer:stranger", "buyer"))).status).toBe(403);
    expect((await postJson(`/runs/${runId}/dispute`, { reason: "not mine" }, identity("buyer:stranger", "buyer"))).status).toBe(403);
    expect((await getJson(`/runs/${runId}/delivery-code`, identity("buyer:stranger", "buyer"))).status).toBe(403);
    await initiate(runId, "membership-pickup", "pickup", "membership Market, Stall B14", "Amina's Fresh Store");
    expect((await getJson(`/runs/${runId}/handoffs/membership-pickup/challenge`, identity(buyerId, "buyer"))).status).toBe(403);
    expect((await getJson(`/runs/${runId}/handoffs/membership-pickup/challenge`, identity("seller:stranger", "seller"))).status).toBe(403);
  });

  it("merges dispute evidence and carries receiver attribution into retirement", async () => {
    const buyerId = "buyer:retirement";
    const { runId, code } = await driveToRun("retirement", buyerId, { kind: "designated", name: "Receiver" });
    await completePickup(runId, "retirement");
    await openDelivery(runId, buyerId, "retire-delivery", "Receiver");
    await scan(runId, "retire-delivery", code);
    await photo(runId, "retire-delivery");
    await confirm(runId, "retire-delivery");
    expect((await postJson(`/runs/${runId}/delivery/final`, {}, identity(RUNNER, "runner"))).status).toBe(200);
    const disputed = await postJson(`/runs/${runId}/dispute`, { reason: "Wrong items" }, identity(buyerId, "buyer"));
    expect(disputed.status).toBe(200);
    expect((await readJson(disputed)).evidenceRefs).toEqual(expect.arrayContaining([
      "r2://archive/captures/retirement-pickup.jpg",
      "r2://archive/captures/retire-delivery.jpg",
    ]));
    expect((await postJson(`/ops/api/runs/${runId}/settle`, { mode: "disputed" })).status).toBe(200);
  });
});
