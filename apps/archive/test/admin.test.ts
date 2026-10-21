import { describe, expect, it } from "vitest";
import type { liveRuns, runsArchive } from "../../../infra/drizzle/schema.js";
import {
  adminRunSummary,
  liveRunEntry,
  mergeRunEntries,
  parseListParams,
  parseOpsHealthQuery,
  parseRunKindFilter,
} from "../src/admin.js";

const now = 1_800_000_000_000;

type LiveRunRow = typeof liveRuns.$inferSelect;
type RunsArchiveRow = typeof runsArchive.$inferSelect;

function liveRow(overrides: Partial<LiveRunRow>): LiveRunRow {
  return {
    runId: "run:live:1",
    market: "Balogun",
    status: "collecting",
    runnerId: null,
    buyerId: "buyer-1",
    startedAt: new Date(now),
    retiredAt: null,
    stopCount: 3,
    storeIds: ["Amina's Fresh Store"],
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ...overrides,
  };
}

function archiveRow(overrides: Partial<RunsArchiveRow>): RunsArchiveRow {
  return {
    id: "run:archived:1",
    cartId: "cart:1",
    marketId: "Balogun",
    buyerId: "buyer-1",
    runnerId: "runner:internal",
    status: "closed",
    delivery: { kind: "plus-code", plusCode: "6FR5+8X Lagos" },
    floorRateKobo: 170_000,
    startedAt: new Date(now - 3_600_000),
    finalDeliveryAt: new Date(now - 600_000),
    closedAt: new Date(now),
    createdAt: new Date(now),
    ...overrides,
  };
}

describe("admin wire shaping", () => {
  it("shapes a live_runs row as a LiveRun entry with epoch-ms timestamps", () => {
    const entry = liveRunEntry(liveRow({}));
    expect(entry).toEqual({
      kind: "live",
      runId: "run:live:1",
      market: "Balogun",
      status: "collecting",
      runnerId: null,
      buyerId: "buyer-1",
      startedAt: now,
      retiredAt: null,
      stopCount: 3,
      storeIds: ["Amina's Fresh Store"],
    });
  });

  it("shapes a runs_archive row as an AdminRunSummary entry", () => {
    const entry = adminRunSummary(archiveRow({}));
    expect(entry).toEqual({
      kind: "archived",
      runId: "run:archived:1",
      cartId: "cart:1",
      market: "Balogun",
      buyerId: "buyer-1",
      runnerId: "runner:internal",
      status: "closed",
      floorRateKobo: 170_000,
      startedAt: now - 3_600_000,
      finalDeliveryAt: now - 600_000,
      closedAt: now,
    });
  });

  it("tolerates NULL started/final-delivery timestamps on archived rows", () => {
    const entry = adminRunSummary(archiveRow({ startedAt: null, finalDeliveryAt: null }));
    expect(entry.startedAt).toBeNull();
    expect(entry.finalDeliveryAt).toBeNull();
  });
});

describe("mergeRunEntries", () => {
  it("merges live and archived entries newest-first across sources", () => {
    const live = [
      liveRow({ runId: "run:live:new", startedAt: new Date(now + 2_000) }),
      liveRow({ runId: "run:live:old", startedAt: new Date(now - 2_000) }),
    ];
    const archived = [archiveRow({ id: "run:archived:mid", closedAt: new Date(now) })];
    const page = mergeRunEntries(live, archived, { limit: 50, offset: 0 });
    expect(page.total).toBe(3);
    expect(page.items.map((item) => item.runId)).toEqual([
      "run:live:new",
      "run:archived:mid",
      "run:live:old",
    ]);
  });

  it("applies offset and limit to the merged list", () => {
    const live = Array.from({ length: 5 }, (_, i) =>
      liveRow({ runId: `run:live:${i}`, startedAt: new Date(now - i * 1_000) }),
    );
    const page = mergeRunEntries(live, [], { limit: 2, offset: 1 });
    expect(page.total).toBe(5);
    expect(page.items.map((item) => item.runId)).toEqual(["run:live:1", "run:live:2"]);
    expect(page.limit).toBe(2);
    expect(page.offset).toBe(1);
  });
});

describe("admin query params", () => {
  it("defaults limit and offset", () => {
    expect(parseListParams(new URL("https://x/admin/runs"))).toEqual({ limit: 50, offset: 0 });
  });

  it("parses explicit limit and offset", () => {
    expect(parseListParams(new URL("https://x/admin/runs?limit=10&offset=40"))).toEqual({ limit: 10, offset: 40 });
  });

  it("rejects non-integer or out-of-range pagination", () => {
    for (const bad of ["limit=0", "limit=201", "limit=abc", "offset=-1", "offset=1.5"]) {
      const result = parseListParams(new URL(`https://x/admin/runs?${bad}`));
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(400);
    }
  });

  it("requires market for ops-health", () => {
    const missing = parseOpsHealthQuery(new URL("https://x/admin/ops-health"));
    expect(missing).toBeInstanceOf(Response);
    expect((missing as Response).status).toBe(400);
    expect(parseOpsHealthQuery(new URL("https://x/admin/ops-health?market=Balogun"))).toEqual({ market: "Balogun" });
  });

  it("parses the /admin/runs kind source filter and rejects unknown kinds", () => {
    expect(parseRunKindFilter(new URL("https://x/admin/runs"))).toBeNull();
    expect(parseRunKindFilter(new URL("https://x/admin/runs?kind=live"))).toBe("live");
    expect(parseRunKindFilter(new URL("https://x/admin/runs?kind=archived"))).toBe("archived");
    const bad = parseRunKindFilter(new URL("https://x/admin/runs?kind=old"));
    expect(bad).toBeInstanceOf(Response);
    expect((bad as Response).status).toBe(400);
  });
});
