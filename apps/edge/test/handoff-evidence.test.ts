import { SELF, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { HANDOFF_AUTO_CONFIRM_MS } from "@market-runs/domain";
import { OpsRunDetailSchema } from "@market-runs/proto";
import { readJson, runStub, shiftTime } from "./helpers.js";

/**
 * The evidence chain of the handoff photo handshake (ADR-0007), exercised
 * over the PUBLIC HTTP surface (SELF): camera bytes → capture endpoint → R2
 * read-back; the runner's photo reference → the run wire every counterparty
 * reads; and a dispute gathering the run's photo refs into evidenceRefs,
 * carried into the retirement snapshot for the archive's disputes table.
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

async function attachRunSocket(runId: string): Promise<{ waitFor: (type: string) => Promise<Record<string, unknown>> }> {
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
  return { waitFor };
}

/** Drive a market from intent to a live run; returns the run id. */
async function driveToRun(market: string, buyerId: string): Promise<string> {
  const intentId = `he-intent-${market}`;
  const productId = `he-product-${market}`;

  const posted = await postJson("/command", {
    type: "intent.posted", intentId, shopItem: "Tomatoes", quantity: 2, unit: "kg",
    priceBand: { minKobo: 120_000, maxKobo: 180_000 }, note: "firm and ripe", market, buyerId,
  });
  expect(posted.status).toBe(200);

  const offered = await postJson(`/markets/${market}/offers`, {
    productId, intentId, market, shopItem: "Tomatoes", quantity: 2, unit: "kg",
    priceKobo: 165_000, sellerName: "Amina's Fresh Store", exchangePoint: `${market} Market, Stall B14`,
  });
  expect(offered.status).toBe(200);

  const accepted = await postJson("/command", { type: "product.accepted", productId });
  expect(accepted.status).toBe(200);
  const cartId = String(((await readJson(accepted)).cart as { id: string }).id);

  const checkoutResponse = await postJson("/command", {
    type: "checkout.requested", cartId, buyerId,
    delivery: { kind: "plus-code", plusCode: "6FR5+8X Lagos" },
  });
  expect(checkoutResponse.status).toBe(200);
  const checkoutEvent = await readJson(checkoutResponse);
  expect(checkoutEvent.type).toBe("checkout.accepted");
  return String(checkoutEvent.runId);
}

interface WireHandoff {
  id: string;
  status: string;
  photoCaptureRef?: string;
  photoCapturedAt?: number;
  scannedAt?: number;
  confirmedAt?: number;
  autoConfirmed?: boolean;
  awaitingPhoto?: boolean;
}

async function wireHandoffs(runId: string): Promise<WireHandoff[]> {
  const response = await getJson(`/runs/${runId}`);
  expect(response.status).toBe(200);
  const body = await readJson(response);
  return (body.run as { handoffs: WireHandoff[] }).handoffs;
}

describe("capture endpoint (camera bytes → R2 → read-back)", () => {
  it("stores jpeg bytes and reads them back with their content type", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const uploaded = await SELF.fetch(new Request(`${BASE}/captures`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: bytes,
    }));
    expect(uploaded.status).toBe(200);
    const body = await readJson(uploaded);
    expect(String(body.ref)).toMatch(/^r2:\/\/archive\/captures\/.+\.jpg$/);
    expect(body.bytes).toBe(bytes.byteLength);

    const readBack = await SELF.fetch(new Request(`${BASE}${String(body.url)}`));
    expect(readBack.status).toBe(200);
    expect(readBack.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await readBack.arrayBuffer())).toEqual(bytes);
  });

  it("refuses non-image bodies, empty bodies, and unknown keys", async () => {
    const wrongType = await SELF.fetch(new Request(`${BASE}/captures`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    }));
    expect(wrongType.status).toBe(415);

    const empty = await SELF.fetch(new Request(`${BASE}/captures`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array([]),
    }));
    expect(empty.status).toBe(400);

    expect((await SELF.fetch(new Request(`${BASE}/captures/captures/never-uploaded.jpg`))).status).toBe(404);
    // Keys outside the captures/ prefix are not served.
    expect((await SELF.fetch(new Request(`${BASE}/captures/snapshots/cart.json`))).status).toBe(404);
  });
});

describe("handoff evidence on the wire", () => {
  it("the photo reference and handshake timestamps reach every reader of the run", async () => {
    const runId = await driveToRun("he", "buyer:he");

    const initiated = await postJson(`/runs/${runId}/handoffs`, {
      handoffId: "he-handoff-1", exchangePointId: "he Market, Stall B14", counterparty: "Amina's Fresh Store",
    });
    expect(initiated.status).toBe(200);

    // Pending, no evidence yet — the wire says so honestly.
    let [handoff] = await wireHandoffs(runId);
    expect(handoff.status).toBe("pending");
    expect(handoff.photoCaptureRef).toBeUndefined();
    expect(handoff.confirmedAt).toBeUndefined();

    const capturedAt = Date.now();
    const photo = await postJson(`/runs/${runId}/handoffs/he-handoff-1/photo`, {
      type: "handoff.photo-captured", handoffId: "he-handoff-1",
      photoCaptureRef: "r2://archive/captures/he-handoff-1.jpg", capturedAt,
    });
    expect(photo.status).toBe(200);

    // The buyer/seller polling the run now see the runner's photo reference.
    [handoff] = await wireHandoffs(runId);
    expect(handoff.photoCaptureRef).toBe("r2://archive/captures/he-handoff-1.jpg");
    expect(handoff.photoCapturedAt).toBe(capturedAt);
    expect(handoff.status).toBe("pending");

    const scanned = await postJson("/command", {
      type: "handoff.challenge-scanned", handoffId: "he-handoff-1", runId, scannedAt: Date.now(),
    });
    expect(scanned.status).toBe(200);

    // After the scan: confirmed with the full evidence trail intact.
    [handoff] = await wireHandoffs(runId);
    expect(handoff.status).toBe("confirmed");
    expect(handoff.photoCaptureRef).toBe("r2://archive/captures/he-handoff-1.jpg");
    expect(handoff.scannedAt).toBeDefined();
    expect(handoff.confirmedAt).toBeDefined();
    expect(handoff.autoConfirmed).toBe(false);
  });

  it("a dispute gathers the run's handoff photo refs into evidenceRefs (ADR-0007)", async () => {
    const runId = await driveToRun("he2", "buyer:he2");

    await postJson(`/runs/${runId}/handoffs`, {
      handoffId: "he2-handoff-1", exchangePointId: "he2 Market, Stall B14", counterparty: "Amina's Fresh Store",
    });
    await postJson(`/runs/${runId}/handoffs/he2-handoff-1/photo`, {
      type: "handoff.photo-captured", handoffId: "he2-handoff-1",
      photoCaptureRef: "r2://archive/captures/he2-handoff-1.jpg", capturedAt: Date.now(),
    });

    const disputed = await postJson(`/runs/${runId}/dispute`, {
      reason: "Wrong items delivered",
      evidenceRefs: ["r2://archive/captures/buyer-counterphoto.jpg"],
    });
    expect(disputed.status).toBe(200);
    const body = await readJson(disputed);
    expect(body.disputed).toBe(true);
    // The raiser's refs merge with every handoff photo ref the run holds.
    expect(body.evidenceRefs).toEqual(
      expect.arrayContaining(["r2://archive/captures/buyer-counterphoto.jpg", "r2://archive/captures/he2-handoff-1.jpg"]),
    );

    // A second dispute is a conflict.
    expect((await postJson(`/runs/${runId}/dispute`, { reason: "again" })).status).toBe(409);
  });

  it("the retirement snapshot carries handoffs and dispute evidence to the archive", async () => {
    const runId = await driveToRun("he3", "buyer:he3");
    const { waitFor } = await attachRunSocket(runId);

    await postJson(`/runs/${runId}/handoffs`, {
      handoffId: "he3-handoff-1", exchangePointId: "he3 Market, Stall B14", counterparty: "Amina's Fresh Store",
    });
    await postJson(`/runs/${runId}/handoffs/he3-handoff-1/photo`, {
      type: "handoff.photo-captured", handoffId: "he3-handoff-1",
      photoCaptureRef: "r2://archive/captures/he3-handoff-1.jpg", capturedAt: Date.now(),
    });
    await postJson("/command", {
      type: "handoff.challenge-scanned", handoffId: "he3-handoff-1", runId, scannedAt: Date.now(),
    });
    expect((await postJson(`/runs/${runId}/delivery/final`, {})).status).toBe(200);
    await postJson(`/runs/${runId}/dispute`, { reason: "Items missing from the delivery" });

    // Ops resolves the dispute through the settlement function (ADR-0007).
    const settled = await postJson(`/ops/api/runs/${runId}/settle`, { mode: "disputed" });
    expect(settled.status).toBe(200);

    const retired = await waitFor("run.retired");
    const handoffs = retired.handoffs as WireHandoff[];
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].photoCaptureRef).toBe("r2://archive/captures/he3-handoff-1.jpg");
    expect(handoffs[0].status).toBe("confirmed");
    const dispute = retired.dispute as { reason: string; evidenceRefs: string[] };
    expect(dispute.reason).toBe("Items missing from the delivery");
    expect(dispute.evidenceRefs).toContain("r2://archive/captures/he3-handoff-1.jpg");
  });
});

/**
 * Ops run detail (GET /ops/api/runs/:runId → RunDO GET /ops): the wire run
 * PLUS the live dispute block — reason, raiser, server-merged evidence refs —
 * so ops reviews the evidence before picking a settle mode. ADR-0019 holds
 * throughout: the client run wire and the public /runs scope never enumerate
 * the merged refs.
 */
describe("ops run detail — dispute evidence review before settle", () => {
  it("carries the live dispute block with merged evidence to ops, never to clients", async () => {
    const runId = await driveToRun("heops", "buyer:heops");
    await postJson(`/runs/${runId}/handoffs`, {
      handoffId: "heops-handoff-1", exchangePointId: "heops Market, Stall B14", counterparty: "Amina's Fresh Store",
    });
    await postJson(`/runs/${runId}/handoffs/heops-handoff-1/photo`, {
      type: "handoff.photo-captured", handoffId: "heops-handoff-1",
      photoCaptureRef: "r2://archive/captures/heops-handoff-1.jpg", capturedAt: Date.now(),
    });
    await postJson("/command", {
      type: "handoff.challenge-scanned", handoffId: "heops-handoff-1", runId, scannedAt: Date.now(),
    });
    expect((await postJson(`/runs/${runId}/delivery/final`, {})).status).toBe(200);

    // The buyer raises the dispute, identified through the participant header seam (ADR-0015).
    const disputed = await SELF.fetch(new Request(`${BASE}/runs/${runId}/dispute`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-participant-id": "buyer:heops" },
      body: JSON.stringify({
        reason: "Items missing from the bag",
        evidenceRefs: ["r2://archive/captures/heops-counterphoto.jpg"],
      }),
    }));
    expect(disputed.status).toBe(200);

    const detail = await getJson(`/ops/api/runs/${runId}`);
    expect(detail.status).toBe(200);
    const parsed = OpsRunDetailSchema.safeParse(await readJson(detail));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.run.disputed).toBe(true);
    expect(parsed.data.dispute).toEqual({
      reason: "Items missing from the bag",
      raisedByParticipantId: "buyer:heops",
      evidenceRefs: expect.arrayContaining([
        "r2://archive/captures/heops-counterphoto.jpg",
        "r2://archive/captures/heops-handoff-1.jpg",
      ]),
    });
    // The per-handoff evidence trail rides the ops detail for review.
    const handoff = parsed.data.run.handoffs[0];
    expect(handoff?.photoCaptureRef).toBe("r2://archive/captures/heops-handoff-1.jpg");
    expect(handoff?.scannedAt).toBeDefined();
    expect(handoff?.confirmedAt).toBeDefined();

    // The client wire carries the dispute flag but never the merged refs…
    const client = await readJson(await getJson(`/runs/${runId}`));
    expect(JSON.stringify(client)).not.toContain("heops-counterphoto");
    expect(client.dispute).toBeUndefined();
    // …and the DO's /ops subtree is refused on the public run scope.
    expect((await getJson(`/runs/${runId}/ops`)).status).toBe(404);
    expect((await postJson(`/runs/${runId}/ops/settle`, { mode: "completed" })).status).toBe(404);
  });

  it("carries dispute: null on an undisputed run, with the handoff trail intact", async () => {
    const runId = await driveToRun("heops2", "buyer:heops2");
    await postJson(`/runs/${runId}/handoffs`, {
      handoffId: "heops2-handoff-1", exchangePointId: "heops2 Market, Stall B14", counterparty: "Amina's Fresh Store",
    });

    const detail = await getJson(`/ops/api/runs/${runId}`);
    expect(detail.status).toBe(200);
    const parsed = OpsRunDetailSchema.safeParse(await readJson(detail));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.dispute).toBeNull();
    expect(parsed.data.run.handoffs[0]?.status).toBe("pending");
    expect(parsed.data.run.handoffs[0]?.photoCaptureRef).toBeUndefined();
  });
});

/**
 * Photo-required confirm (the owner's decision amending ADR-0019): no
 * confirm — runner scan, buyer receipt, or the 3-minute auto-confirm — ever
 * lands without the runner's photo evidence. The photo IS the confirm act.
 */
describe("photo-required confirm", () => {
  it("a photoless scan records scannedAt but refuses to confirm (409 photo-required), replaying cleanly", async () => {
    const runId = await driveToRun("pr1", "buyer:pr1");
    await postJson(`/runs/${runId}/handoffs`, {
      handoffId: "pr1-handoff-1", exchangePointId: "pr1 Market, Stall B14", counterparty: "Amina's Fresh Store",
    });

    const scannedAt = Date.now();
    const scan = await postJson("/command", {
      type: "handoff.challenge-scanned", handoffId: "pr1-handoff-1", runId, scannedAt,
    });
    expect(scan.status).toBe(409);
    expect((await readJson(scan)).error).toBe("photo-required");

    // The scan is on the record, but the handoff is still pending.
    let [handoff] = await wireHandoffs(runId);
    expect(handoff.status).toBe("pending");
    expect(handoff.scannedAt).toBe(scannedAt);
    expect(handoff.confirmedAt).toBeUndefined();

    // A re-scan is the same refusal with the same first-scan stamp.
    const rescan = await postJson("/command", {
      type: "handoff.challenge-scanned", handoffId: "pr1-handoff-1", runId, scannedAt: scannedAt + 5000,
    });
    expect(rescan.status).toBe(409);
    [handoff] = await wireHandoffs(runId);
    expect(handoff.status).toBe("pending");
    expect(handoff.scannedAt).toBe(scannedAt);
  });

  it("the photo is the confirm act: attaching it to a scanned handoff confirms", async () => {
    const runId = await driveToRun("pr2", "buyer:pr2");
    await postJson(`/runs/${runId}/handoffs`, {
      handoffId: "pr2-handoff-1", exchangePointId: "pr2 Market, Stall B14", counterparty: "Amina's Fresh Store",
    });
    const scan = await postJson("/command", {
      type: "handoff.challenge-scanned", handoffId: "pr2-handoff-1", runId, scannedAt: Date.now(),
    });
    expect(scan.status).toBe(409); // photo-required

    const photo = await postJson(`/runs/${runId}/handoffs/pr2-handoff-1/photo`, {
      type: "handoff.photo-captured", handoffId: "pr2-handoff-1",
      photoCaptureRef: "r2://archive/captures/pr2-handoff-1.jpg", capturedAt: Date.now(),
    });
    expect(photo.status).toBe(200);

    let [handoff] = await wireHandoffs(runId);
    expect(handoff.status).toBe("confirmed");
    expect(handoff.autoConfirmed).toBe(false);
    expect(handoff.photoCaptureRef).toBe("r2://archive/captures/pr2-handoff-1.jpg");
    expect(handoff.scannedAt).toBeDefined();
    expect(handoff.confirmedAt).toBeDefined();

    // Idempotency: a double-photo updates the ref, a re-scan replays the confirm.
    const doublePhoto = await postJson(`/runs/${runId}/handoffs/pr2-handoff-1/photo`, {
      type: "handoff.photo-captured", handoffId: "pr2-handoff-1",
      photoCaptureRef: "r2://archive/captures/pr2-handoff-1b.jpg", capturedAt: Date.now(),
    });
    expect(doublePhoto.status).toBe(200);
    const rescan = await postJson("/command", {
      type: "handoff.challenge-scanned", handoffId: "pr2-handoff-1", runId, scannedAt: Date.now(),
    });
    expect(rescan.status).toBe(200);
    expect((await readJson(rescan)).type).toBe("handoff.confirmed");
    [handoff] = await wireHandoffs(runId);
    expect(handoff.status).toBe("confirmed");
    expect(handoff.photoCaptureRef).toBe("r2://archive/captures/pr2-handoff-1b.jpg");
  });

  it("an explicit confirm without a photo is refused (409 photo-required)", async () => {
    const runId = await driveToRun("pr3", "buyer:pr3");
    await postJson(`/runs/${runId}/handoffs`, {
      handoffId: "pr3-handoff-1", exchangePointId: "pr3 Market, Stall B14", counterparty: "Amina's Fresh Store",
    });
    const confirm = await postJson(`/runs/${runId}/handoffs/pr3-handoff-1/confirm`, {});
    expect(confirm.status).toBe(409);
    expect((await readJson(confirm)).error).toBe("photo-required");
    const [handoff] = await wireHandoffs(runId);
    expect(handoff.status).toBe("pending");

    // With the photo attached, the buyer's receipt confirm completes.
    await postJson(`/runs/${runId}/handoffs/pr3-handoff-1/photo`, {
      type: "handoff.photo-captured", handoffId: "pr3-handoff-1",
      photoCaptureRef: "r2://archive/captures/pr3-handoff-1.jpg", capturedAt: Date.now(),
    });
    expect((await postJson(`/runs/${runId}/handoffs/pr3-handoff-1/confirm`, {})).status).toBe(200);
  });

  it("auto-confirm fires at the deadline when the photo is attached (buyer silence = consent)", async () => {
    const runId = await driveToRun("pr4", "buyer:pr4");
    const { waitFor } = await attachRunSocket(runId);
    await postJson(`/runs/${runId}/handoffs`, {
      handoffId: "pr4-handoff-1", exchangePointId: "pr4 Market, Stall B14", counterparty: "Amina's Fresh Store",
    });
    await postJson(`/runs/${runId}/handoffs/pr4-handoff-1/photo`, {
      type: "handoff.photo-captured", handoffId: "pr4-handoff-1",
      photoCaptureRef: "r2://archive/captures/pr4-handoff-1.jpg", capturedAt: Date.now(),
    });

    const stub = runStub(runId);
    await shiftTime(stub, HANDOFF_AUTO_CONFIRM_MS + 60_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const confirmed = await waitFor("handoff.confirmed");
    expect(confirmed.handoffId).toBe("pr4-handoff-1");
    expect(confirmed.autoConfirmed).toBe(true);
    const [handoff] = await wireHandoffs(runId);
    expect(handoff.status).toBe("confirmed");
    expect(handoff.autoConfirmed).toBe(true);
  });

  it("auto-confirm never fires photoless: the handoff stays pending, marked awaitingPhoto, and the alarm re-arms", async () => {
    const runId = await driveToRun("pr5", "buyer:pr5");
    await postJson(`/runs/${runId}/handoffs`, {
      handoffId: "pr5-handoff-1", exchangePointId: "pr5 Market, Stall B14", counterparty: "Amina's Fresh Store",
    });

    const stub = runStub(runId);
    await shiftTime(stub, HANDOFF_AUTO_CONFIRM_MS + 60_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // No confirm: still pending, and the wire tells every screen why.
    let [handoff] = await wireHandoffs(runId);
    expect(handoff.status).toBe("pending");
    expect(handoff.awaitingPhoto).toBe(true);
    expect(handoff.confirmedAt).toBeUndefined();

    // The photo lands (unscanned — it attaches, the scan would confirm it);
    // the re-armed alarm then auto-confirms, deadline long past.
    await postJson(`/runs/${runId}/handoffs/pr5-handoff-1/photo`, {
      type: "handoff.photo-captured", handoffId: "pr5-handoff-1",
      photoCaptureRef: "r2://archive/captures/pr5-handoff-1.jpg", capturedAt: Date.now(),
    });
    [handoff] = await wireHandoffs(runId);
    expect(handoff.status).toBe("pending");
    expect(handoff.awaitingPhoto).toBeUndefined();

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    [handoff] = await wireHandoffs(runId);
    expect(handoff.status).toBe("confirmed");
    expect(handoff.autoConfirmed).toBe(true);
  });

  it("final delivery is refused while any handoff awaits photo evidence", async () => {
    const runId = await driveToRun("pr6", "buyer:pr6");

    // The seller pickup confirms normally (photo + scan), completing the stop.
    await postJson(`/runs/${runId}/handoffs`, {
      handoffId: "pr6-pickup", exchangePointId: "pr6 Market, Stall B14", counterparty: "Amina's Fresh Store",
    });
    await postJson(`/runs/${runId}/handoffs/pr6-pickup/photo`, {
      type: "handoff.photo-captured", handoffId: "pr6-pickup",
      photoCaptureRef: "r2://archive/captures/pr6-pickup.jpg", capturedAt: Date.now(),
    });
    expect((await postJson("/command", {
      type: "handoff.challenge-scanned", handoffId: "pr6-pickup", runId, scannedAt: Date.now(),
    })).status).toBe(200);

    // The delivery handoff is open but has no photo yet: the run cannot close.
    await postJson(`/runs/${runId}/handoffs`, {
      handoffId: "pr6-delivery", exchangePointId: "6FR5+8X Lagos", counterparty: "buyer:pr6",
    });
    const refused = await postJson(`/runs/${runId}/delivery/final`, {});
    expect(refused.status).toBe(409);
    expect((await readJson(refused)).error).toBe("photo-required");

    // Photo + scan on the delivery handoff → confirmed → final delivery opens.
    await postJson(`/runs/${runId}/handoffs/pr6-delivery/photo`, {
      type: "handoff.photo-captured", handoffId: "pr6-delivery",
      photoCaptureRef: "r2://archive/captures/pr6-delivery.jpg", capturedAt: Date.now(),
    });
    expect((await postJson("/command", {
      type: "handoff.challenge-scanned", handoffId: "pr6-delivery", runId, scannedAt: Date.now(),
    })).status).toBe(200);
    expect((await postJson(`/runs/${runId}/delivery/final`, {})).status).toBe(200);
  });
});
