import { describe, expect, it } from "vitest";
import { factsFromRunRows, factsFromSellerRows, parseReputationQuery } from "../src/reputation.js";

describe("archive reputation mapping", () => {
  it("maps buyer/run rows to facts, preferring the settlement mode", () => {
    const facts = factsFromRunRows(
      [
        { runId: "run-1", mode: "completed", status: "closed" },
        { runId: "run-2", mode: "aborted", status: "aborted" },
        { runId: "run-3", mode: null, status: "aborted" },
      ],
      "buyer",
    );
    expect(facts).toEqual([
      { runId: "run-1", mode: "completed", role: "buyer" },
      { runId: "run-2", mode: "aborted", role: "buyer" },
      { runId: "run-3", mode: "aborted", role: "buyer" },
    ]);
  });

  it("treats an unreleased closed run as completed", () => {
    const facts = factsFromRunRows([{ runId: "run-1", mode: null, status: "closed" }], "runner");
    expect(facts[0]?.mode).toBe("completed");
  });

  it("maps seller legs to facts with stop completion, including failed-stop strikes", () => {
    const facts = factsFromSellerRows([
      { runId: "run-1", mode: "completed", stopCompleted: true },
      { runId: "run-2", mode: "aborted", stopCompleted: false },
    ]);
    expect(facts).toEqual([
      { runId: "run-1", mode: "completed", role: "seller", stopCompleted: true },
      { runId: "run-2", mode: "aborted", role: "seller", stopCompleted: false },
    ]);
  });

  it("validates the reputation query params", () => {
    expect(parseReputationQuery(new URL("http://a/reputation?participant=buyer-1&role=runner")))
      .toEqual({ participantId: "buyer-1", role: "runner" });
    expect(parseReputationQuery(new URL("http://a/reputation"))).toBeInstanceOf(Response);
    expect(parseReputationQuery(new URL("http://a/reputation?participant=x&role=admin"))).toBeInstanceOf(Response);
  });
});
