import { describe, expect, it } from "vitest";
import { computeOpsHealth, weekIndex, OPS_GATE_THRESHOLDS, type OpsRunFact } from "../src/ops-health.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
/** A known Monday (UTC) to anchor week buckets. */
const MONDAY = Date.UTC(2026, 0, 5); // 2026-01-05 is a Monday

function fact(overrides: Partial<OpsRunFact> & { runId: string }): OpsRunFact {
  return {
    buyerId: "buyer-1",
    closedAt: MONDAY + 12 * 3_600_000,
    mode: "completed",
    opsIntervention: false,
    ...overrides,
  };
}

/** n clean runs, one per buyer, in the week starting `weeksAgo` weeks before the anchor week. */
function cleanWeek(n: number, weeksAgo: number, buyerPrefix = "buyer"): OpsRunFact[] {
  return Array.from({ length: n }, (_, i) =>
    fact({
      runId: `run:${weeksAgo}:${buyerPrefix}:${i}`,
      buyerId: `${buyerPrefix}-${i}`,
      closedAt: MONDAY - weeksAgo * WEEK_MS + (i + 1) * 3_600_000,
    }),
  );
}

describe("weekIndex", () => {
  it("is Monday-aligned in UTC", () => {
    expect(weekIndex(MONDAY)).toBe(weekIndex(MONDAY + 6 * 24 * 3_600_000 + 23 * 3_600_000));
    expect(weekIndex(MONDAY - 1)).toBe(weekIndex(MONDAY) - 1);
    expect(weekIndex(MONDAY + WEEK_MS)).toBe(weekIndex(MONDAY) + 1);
  });
});

describe("computeOpsHealth", () => {
  it("reports a zeroed, unpassed gate with no history", () => {
    const health = computeOpsHealth([]);
    expect(health).toEqual({
      consecutiveQualifyingWeeks: 0,
      completedRuns: 0,
      disputeRateBps: 0,
      zeroTouchRateBps: 0,
      repeatBuyers: 0,
      gate: {
        qualifyingWeeks: { threshold: 8, pass: false },
        completedRuns: { threshold: 500, pass: false },
        disputeRateBps: { threshold: 500, pass: false },
        zeroTouchRateBps: { threshold: 6_000, pass: false },
        repeatBuyers: { threshold: 30, pass: false },
        pass: false,
      },
    });
  });

  it("counts consecutive qualifying weeks back from the latest active week", () => {
    const facts = [...cleanWeek(10, 2), ...cleanWeek(10, 1), ...cleanWeek(10, 0)];
    const health = computeOpsHealth(facts);
    expect(health.consecutiveQualifyingWeeks).toBe(3);
    expect(health.completedRuns).toBe(30);
    expect(health.disputeRateBps).toBe(0);
    expect(health.zeroTouchRateBps).toBe(10_000);
  });

  it("breaks the streak at a week that fails the rate criteria", () => {
    // Week 1 (one week ago) has a 10% dispute rate → not qualifying.
    const badWeek = Array.from({ length: 10 }, (_, i) =>
      fact({
        runId: `run:bad:${i}`,
        buyerId: `bad-${i}`,
        closedAt: MONDAY - WEEK_MS + (i + 1) * 3_600_000,
        ...(i === 0 ? { mode: "disputed" as const, opsIntervention: true } : {}),
      }),
    );
    const health = computeOpsHealth([...cleanWeek(10, 2), ...badWeek, ...cleanWeek(10, 0)]);
    expect(health.consecutiveQualifyingWeeks).toBe(1);
  });

  it("treats a runless gap week as a streak break", () => {
    const health = computeOpsHealth([...cleanWeek(10, 2), ...cleanWeek(10, 0)]);
    expect(health.consecutiveQualifyingWeeks).toBe(1);
  });

  it("ignores future-unrelated older history once the streak breaks", () => {
    // 10 qualifying weeks, then a bad week, then 2 qualifying weeks.
    const facts = [
      ...Array.from({ length: 10 }, (_, w) => cleanWeek(5, w + 3, `old-${w}`)).flat(),
      ...cleanWeek(5, 2).map((f, i) => ({ ...f, mode: "disputed" as const, opsIntervention: true, runId: `bad:${i}` })),
      ...cleanWeek(5, 1, "new-1"),
      ...cleanWeek(5, 0, "new-0"),
    ];
    const health = computeOpsHealth(facts);
    expect(health.consecutiveQualifyingWeeks).toBe(2);
  });

  it("computes dispute and zero-touch rates in basis points over all completed runs", () => {
    // 4 runs: 1 disputed (ops intervention), 1 ops-touched but completed, 2 clean.
    const facts = [
      fact({ runId: "run-1", mode: "disputed", opsIntervention: true }),
      fact({ runId: "run-2", buyerId: "buyer-2", opsIntervention: true }),
      fact({ runId: "run-3", buyerId: "buyer-3" }),
      fact({ runId: "run-4", buyerId: "buyer-4" }),
    ];
    const health = computeOpsHealth(facts);
    expect(health.completedRuns).toBe(4);
    expect(health.disputeRateBps).toBe(2_500);
    expect(health.zeroTouchRateBps).toBe(5_000);
    // 25% dispute in the only week → the week does not qualify.
    expect(health.consecutiveQualifyingWeeks).toBe(0);
  });

  it("counts aborted runs as completed runs without touching the dispute rate", () => {
    const facts = [fact({ runId: "run-1", mode: "aborted" }), fact({ runId: "run-2", buyerId: "buyer-2" })];
    const health = computeOpsHealth(facts);
    expect(health.completedRuns).toBe(2);
    expect(health.disputeRateBps).toBe(0);
    expect(health.consecutiveQualifyingWeeks).toBe(1);
  });

  it("counts repeat buyers as buyers with more than one completed run", () => {
    const facts = [
      fact({ runId: "run-1", buyerId: "repeat-1" }),
      fact({ runId: "run-2", buyerId: "repeat-1" }),
      fact({ runId: "run-3", buyerId: "repeat-2" }),
      fact({ runId: "run-4", buyerId: "repeat-2" }),
      fact({ runId: "run-5", buyerId: "repeat-2" }),
      fact({ runId: "run-6", buyerId: "once" }),
    ];
    expect(computeOpsHealth(facts).repeatBuyers).toBe(2);
  });

  it("passes the full gate only when every metric passes", () => {
    // 8 qualifying weeks × 63 runs = 504 completed, 40 buyers each running
    // twice across the window (80 repeat runs → 40 repeat buyers).
    const facts: OpsRunFact[] = [];
    for (let w = 0; w < 8; w += 1) {
      for (let i = 0; i < 63; i += 1) {
        const buyer = i < 40 ? `repeat-${i}` : `single-${w}-${i}`;
        facts.push(
          fact({
            runId: `run:${w}:${i}`,
            buyerId: buyer,
            closedAt: MONDAY - w * WEEK_MS + (i + 1) * 60_000,
          }),
        );
        if (i < 40) {
          facts.push(
            fact({
              runId: `run:${w}:${i}:second`,
              buyerId: buyer,
              closedAt: MONDAY - w * WEEK_MS + (i + 1) * 60_000 + 30_000,
            }),
          );
        }
      }
    }
    const health = computeOpsHealth(facts);
    expect(health.consecutiveQualifyingWeeks).toBe(8);
    expect(health.completedRuns).toBe(8 * (63 + 40));
    expect(health.repeatBuyers).toBe(40);
    expect(health.gate.qualifyingWeeks.pass).toBe(true);
    expect(health.gate.completedRuns.pass).toBe(true);
    expect(health.gate.disputeRateBps.pass).toBe(true);
    expect(health.gate.zeroTouchRateBps.pass).toBe(true);
    expect(health.gate.repeatBuyers.pass).toBe(true);
    expect(health.gate.pass).toBe(true);
  });

  it("keeps the dispute gate strict: exactly 500 bps fails (<5% required)", () => {
    // 2 runs, 1 disputed → 5 000 bps would fail anyway; use 200 runs, 10 disputed = 500 bps.
    const facts = Array.from({ length: 200 }, (_, i) =>
      fact({
        runId: `run-${i}`,
        buyerId: `buyer-${i}`,
        ...(i < 10 ? { mode: "disputed" as const, opsIntervention: true } : {}),
      }),
    );
    const health = computeOpsHealth(facts);
    expect(health.disputeRateBps).toBe(OPS_GATE_THRESHOLDS.disputeRateBps);
    expect(health.gate.disputeRateBps.pass).toBe(false);
    expect(health.consecutiveQualifyingWeeks).toBe(0);
  });
});
