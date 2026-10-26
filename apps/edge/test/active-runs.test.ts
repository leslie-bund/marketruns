import { SELF, fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { createApp } from "../src/app/app.js";
import {
  acceptProduct,
  bindings,
  checkout,
  offerProduct,
  postIntent,
  readJson,
} from "./helpers.js";
import {
  completePickup,
  confirm as confirmHandoff,
  driveToRun as driveReceiverRun,
  openDelivery,
  photo as attachHandoffPhoto,
  postJson as postRunJson,
  runView,
  scan as scanHandoff,
} from "./handoff-helpers.js";

const BASE = "http://edge";
const ARCHIVE = "http://localhost:8788";

function getActiveRuns(market: string, runnerId?: string): Promise<Response> {
  const headers = new Headers();
  if (runnerId !== undefined) {
    headers.set("x-participant-id", runnerId);
    headers.set("x-participant-role", "runner");
  }
  return SELF.fetch(new Request(`${BASE}/markets/${market}/runs/active`, { headers }));
}

function getActiveRunsAsSeller(market: string, storeId?: string): Promise<Response> {
  const headers = new Headers({ "x-participant-id": "seller:demo", "x-participant-role": "seller" });
  const query = storeId === undefined ? "" : `?storeId=${encodeURIComponent(storeId)}`;
  return SELF.fetch(new Request(`${BASE}/markets/${market}/runs/active${query}`, { headers }));
}

function postJson(path: string, body: unknown, participantId?: string): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (participantId !== undefined) {
    headers.set("x-participant-id", participantId);
    headers.set("x-participant-role", "buyer");
  }
  return SELF.fetch(new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

/** The test bindings with OPS_ARCHIVE_URL removed (deployed-misconfiguration branch). */
function withoutArchiveUrl(): Env {
  return new Proxy(bindings, {
    get: (target, prop, receiver) => (prop === "OPS_ARCHIVE_URL" ? undefined : Reflect.get(target, prop, receiver)),
  }) as Env;
}

function liveEntry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "live",
    runId: "run:cart:ar:buyer:x",
    market: "ar",
    status: "collecting",
    runnerId: "runner:internal",
    buyerId: "buyer:x",
    startedAt: 1_700_000_000_000,
    retiredAt: null,
    stopCount: 1,
    storeIds: ["Amina's Fresh Store"],
    ...overrides,
  };
}

/**
 * Runner run discovery (GET /markets/:market/runs/active): a client-safe read
 * of the archive's live_runs index, filtered to the caller's runner identity.
 * The index is not doctrine — every failure mode degrades to `{ runs: [] }`
 * with a warning rather than breaking the runner screen.
 */
describe("runner run discovery", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterAll(() => {
    fetchMock.deactivate();
  });

  it("returns only the caller's live runs, excluding retired, archived, and other runners' runs", async () => {
    const payload = {
      items: [
        liveEntry({ runId: "run:cart:ar:buyer:new", buyerId: "buyer:new", startedAt: 1_700_000_002_000, stopCount: 2 }),
        liveEntry({ runId: "run:cart:ar:buyer:old", buyerId: "buyer:old", startedAt: 1_700_000_000_500 }),
        liveEntry({ runId: "run:cart:ar:buyer:other", buyerId: "buyer:other", runnerId: "runner:other", startedAt: 1_700_000_001_000 }),
        liveEntry({ runId: "run:cart:ar:buyer:ret", buyerId: "buyer:ret", status: "closed", retiredAt: 1_700_000_100_000 }),
        {
          kind: "archived",
          runId: "run:cart:ar:buyer:arch",
          cartId: "cart:ar:buyer:arch",
          market: "ar",
          buyerId: "buyer:arch",
          runnerId: "runner:internal",
          status: "closed",
          floorRateKobo: 170_000,
          startedAt: 1_699_999_000_000,
          finalDeliveryAt: 1_699_999_500_000,
          closedAt: 1_700_000_000_100,
        },
      ],
      total: 5,
      limit: 200,
      offset: 0,
    };
    fetchMock
      .get(ARCHIVE)
      .intercept({
        path: "/admin/runs",
        query: { market: "ar", runnerId: "runner:internal", kind: "live", limit: "200" },
      })
      .reply(200, JSON.stringify(payload), { headers: { "content-type": "application/json" } });

    const response = await getActiveRuns("ar", "runner:internal");
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.warning).toBeUndefined();
    // Newest first; the other runner's run, the retired run, and the archived
    // run are all excluded even though the (mocked) archive returned them.
    expect(body.runs).toEqual([
      {
        runId: "run:cart:ar:buyer:new",
        market: "ar",
        status: "collecting",
        buyerId: "buyer:new",
        startedAt: 1_700_000_002_000,
        stopCount: 2,
      },
      {
        runId: "run:cart:ar:buyer:old",
        market: "ar",
        status: "collecting",
        buyerId: "buyer:old",
        startedAt: 1_700_000_000_500,
        stopCount: 1,
      },
    ]);
  });

  it("anonymous callers have no runner identity and get an empty list without touching the archive", async () => {
    // No intercept registered for this market: any archive call would throw
    // under disableNetConnect and set a warning — its absence proves the
    // short-circuit.
    const response = await getActiveRuns("ar-anon");
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.runs).toEqual([]);
    expect(body.warning).toBeUndefined();
  });

  it("degrades to an empty list with a warning when the archive does not respond", async () => {
    const response = await getActiveRuns("ar-down", "runner:internal");
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.runs).toEqual([]);
    expect(String(body.warning)).toContain("did not respond");
  });

  it("degrades with a warning when the archive answers badly", async () => {
    fetchMock
      .get(ARCHIVE)
      .intercept({ path: "/admin/runs", query: { market: "ar-500", runnerId: "runner:internal", kind: "live", limit: "200" } })
      .reply(500, "boom");
    const fiveHundred = await getActiveRuns("ar-500", "runner:internal");
    expect(fiveHundred.status).toBe(200);
    const fiveHundredBody = await readJson(fiveHundred);
    expect(fiveHundredBody.runs).toEqual([]);
    expect(String(fiveHundredBody.warning)).toContain("500");

    fetchMock
      .get(ARCHIVE)
      .intercept({ path: "/admin/runs", query: { market: "ar-bad", runnerId: "runner:internal", kind: "live", limit: "200" } })
      .reply(200, JSON.stringify({ items: [{ nope: true }] }), { headers: { "content-type": "application/json" } });
    const badShape = await getActiveRuns("ar-bad", "runner:internal");
    expect(badShape.status).toBe(200);
    const badBody = await readJson(badShape);
    expect(badBody.runs).toEqual([]);
    expect(String(badBody.warning)).toContain("unexpected shape");
  });

  it("degrades with a warning when OPS_ARCHIVE_URL is not configured", async () => {
    const app = createApp();
    const response = await app.fetch(
      new Request(`${BASE}/markets/ar-unset/runs/active`, {
        headers: { "x-participant-id": "runner:internal", "x-participant-role": "runner" },
      }),
      withoutArchiveUrl(),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.runs).toEqual([]);
    expect(String(body.warning)).toContain("not configured");
  });
});

/**
 * Seller run discovery: the same client-safe read, scoped by the `storeId`
 * query param to live runs containing the caller's store. The param is
 * client-asserted under the dev-stage header seam (ADR-0015) — the store
 * registry records no owner participant id yet.
 */
describe("seller run discovery", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterAll(() => {
    fetchMock.deactivate();
  });

  it("returns only live runs containing the caller's store, newest first", async () => {
    const payload = {
      items: [
        liveEntry({ runId: "run:cart:as:buyer:new", market: "as", buyerId: "buyer:new", startedAt: 1_700_000_002_000, stopCount: 2 }),
        liveEntry({
          runId: "run:cart:as:buyer:other",
          market: "as",
          buyerId: "buyer:other",
          storeIds: ["Some Other Store"],
          startedAt: 1_700_000_001_500,
        }),
        liveEntry({ runId: "run:cart:as:buyer:old", market: "as", buyerId: "buyer:old", startedAt: 1_700_000_000_500 }),
        liveEntry({ runId: "run:cart:as:buyer:ret", market: "as", buyerId: "buyer:ret", status: "closed", retiredAt: 1_700_000_100_000 }),
        {
          kind: "archived",
          runId: "run:cart:as:buyer:arch",
          cartId: "cart:as:buyer:arch",
          market: "as",
          buyerId: "buyer:arch",
          runnerId: "runner:internal",
          status: "closed",
          floorRateKobo: 170_000,
          startedAt: 1_699_999_000_000,
          finalDeliveryAt: 1_699_999_500_000,
          closedAt: 1_700_000_000_100,
        },
      ],
      total: 5,
      limit: 200,
      offset: 0,
    };
    fetchMock
      .get(ARCHIVE)
      .intercept({
        path: "/admin/runs",
        query: { market: "as", storeId: "Amina's Fresh Store", kind: "live", limit: "200" },
      })
      .reply(200, JSON.stringify(payload), { headers: { "content-type": "application/json" } });

    const response = await getActiveRunsAsSeller("as", "Amina's Fresh Store");
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.warning).toBeUndefined();
    // The other store's run, the retired run, and the archived run are all
    // excluded even though the (mocked) archive returned them.
    expect(body.runs).toEqual([
      {
        runId: "run:cart:as:buyer:new",
        market: "as",
        status: "collecting",
        buyerId: "buyer:new",
        startedAt: 1_700_000_002_000,
        stopCount: 2,
      },
      {
        runId: "run:cart:as:buyer:old",
        market: "as",
        status: "collecting",
        buyerId: "buyer:old",
        startedAt: 1_700_000_000_500,
        stopCount: 1,
      },
    ]);
  });

  it("rejects a seller call without a storeId query param", async () => {
    const response = await getActiveRunsAsSeller("as-nostore");
    expect(response.status).toBe(400);
    const body = await readJson(response);
    expect(body.error).toBe("invalid-query");
  });

  it("degrades to an empty list with a warning when the archive does not respond", async () => {
    const response = await getActiveRunsAsSeller("as-down", "Amina's Fresh Store");
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.runs).toEqual([]);
    expect(String(body.warning)).toContain("did not respond");
  });
});

/** Dispute state rides the run wire after a member files it. */
describe("dispute state on the run wire", () => {
  it("carries disputed, disputeRaisedByParticipantId, and finalDeliveryAt", async () => {
    const buyerId = "buyer:dsw-new";
    const { runId, code } = await driveReceiverRun("dsw-new", buyerId, { kind: "designated", name: "Receiver" });
    const initial = await runView(runId, buyerId);
    expect(initial.disputed).toBe(false);
    expect(initial.disputeRaisedByParticipantId).toBeNull();
    expect(initial.finalDeliveryAt).toBeNull();
    expect((await postRunJson(`/runs/${runId}/dispute`, { reason: "items missing" }, { "x-participant-id": buyerId, "x-participant-role": "buyer" })).status).toBe(200);
    expect((await runView(runId, buyerId)).disputeRaisedByParticipantId).toBe(buyerId);
    await completePickup(runId, "dsw-new");
    await openDelivery(runId, buyerId, "dsw-delivery", "Receiver");
    await scanHandoff(runId, "dsw-delivery", code);
    await attachHandoffPhoto(runId, "dsw-delivery");
    expect((await confirmHandoff(runId, "dsw-delivery")).status).toBe(200);
    expect((await postRunJson(`/runs/${runId}/delivery/final`, {}, { "x-participant-id": "runner:internal", "x-participant-role": "runner" })).status).toBe(200);
    const final = await runView(runId, buyerId);
    expect(final.status).toBe("delivered");
    expect(typeof final.finalDeliveryAt).toBe("number");
    expect(final.disputed).toBe(true);
  });
});
