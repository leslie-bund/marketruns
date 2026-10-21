import { describe, expect, it } from "vitest";
import { computeReputation, type ReputationFact } from "../src/reputation.js";

describe("computeReputation", () => {
  it("reports a neutral profile with no history", () => {
    expect(computeReputation("buyer-1", [])).toEqual({
      participantId: "buyer-1",
      completedTrips: 0,
      abortedTrips: 0,
      disputedTrips: 0,
      strikes: 0,
      abortRateBps: 0,
      standingBps: 10_000,
    });
  });

  it("counts completed trips per role and keeps full standing", () => {
    const facts: ReputationFact[] = [
      { runId: "run-1", mode: "completed", role: "buyer" },
      { runId: "run-2", mode: "completed", role: "buyer" },
      { runId: "run-3", mode: "completed", role: "buyer" },
    ];
    const reputation = computeReputation("buyer-1", facts);
    expect(reputation.completedTrips).toBe(3);
    expect(reputation.abortRateBps).toBe(0);
    expect(reputation.standingBps).toBe(10_000);
  });

  it("computes abort rate in basis points and penalizes standing", () => {
    const facts: ReputationFact[] = [
      { runId: "run-1", mode: "completed", role: "runner" },
      { runId: "run-2", mode: "aborted", role: "runner" },
    ];
    const reputation = computeReputation("runner-1", facts);
    expect(reputation.completedTrips).toBe(1);
    expect(reputation.abortedTrips).toBe(1);
    expect(reputation.abortRateBps).toBe(5_000);
    expect(reputation.standingBps).toBe(8_000);
  });

  it("strikes a seller whose stop failed, in any mode (ADR-0008)", () => {
    const facts: ReputationFact[] = [
      { runId: "run-1", mode: "aborted", role: "seller", stopCompleted: false },
    ];
    const reputation = computeReputation("seller-1", facts);
    expect(reputation.strikes).toBe(1);
    expect(reputation.abortedTrips).toBe(0); // the failed stop is a strike, not a trip
    expect(reputation.standingBps).toBe(8_500);
  });

  it("counts a completed seller stop as a completed trip", () => {
    const facts: ReputationFact[] = [
      { runId: "run-1", mode: "completed", role: "seller", stopCompleted: true },
    ];
    const reputation = computeReputation("seller-1", facts);
    expect(reputation.completedTrips).toBe(1);
    expect(reputation.strikes).toBe(0);
  });

  it("strikes a participant faulted by a dispute outcome", () => {
    const facts: ReputationFact[] = [
      { runId: "run-1", mode: "disputed", role: "runner" },
      { runId: "run-2", mode: "disputed", role: "runner", faulted: true },
    ];
    const reputation = computeReputation("runner-1", facts);
    expect(reputation.disputedTrips).toBe(2);
    expect(reputation.strikes).toBe(1);
    expect(reputation.abortRateBps).toBe(0); // disputes are not aborts
    expect(reputation.standingBps).toBe(8_500);
  });

  it("floors standing at zero under heavy penalties", () => {
    const facts: ReputationFact[] = Array.from({ length: 8 }, (_, index) => ({
      runId: `run-${index}`,
      mode: "aborted" as const,
      role: "runner" as const,
    }));
    expect(computeReputation("runner-1", facts).standingBps).toBe(0);
  });

  it("ignores facts for other runs' roles without mixing counters", () => {
    const facts: ReputationFact[] = [
      { runId: "run-1", mode: "completed", role: "buyer" },
      { runId: "run-1", mode: "completed", role: "runner" },
    ];
    const buyer = computeReputation("buyer-1", facts.filter((fact) => fact.role === "buyer"));
    const runner = computeReputation("runner-1", facts.filter((fact) => fact.role === "runner"));
    expect(buyer.completedTrips).toBe(1);
    expect(runner.completedTrips).toBe(1);
  });
});
