import assert from "node:assert/strict";
import test from "node:test";
import { canRunnerMutate, partitionRunnerRuns, preferredRunnerRunId } from "../src/features/run/runner-state.ts";

const active = (runId, status) => ({
  runId,
  market: "Balogun",
  status,
  buyerId: "buyer:test",
  startedAt: 1,
  stopCount: 2,
});

const run = (status, runnerId) => ({
  id: "run:cart:Balogun:buyer:test",
  market: "Balogun",
  status,
  floorRateKobo: 1000,
  delivery: { kind: "muster-point", name: "Gate" },
  stops: [],
  handoffs: [],
  ...(runnerId ? { runnerId } : {}),
});

test("pool discovery separates unassigned work from the caller's claimed runs", () => {
  const result = partitionRunnerRuns([active("available", "unassigned"), active("mine", "collecting")]);
  assert.deepEqual(result.available.map((entry) => entry.runId), ["available"]);
  assert.deepEqual(result.claimed.map((entry) => entry.runId), ["mine"]);
});

test("selection never auto-opens an unassigned run", () => {
  assert.equal(preferredRunnerRunId([active("available", "unassigned")]), null);
  assert.equal(preferredRunnerRunId([active("available", "unassigned"), active("mine", "assigned")]), "mine");
});

test("runner commands require a claimed run owned by this participant", () => {
  assert.equal(canRunnerMutate(run("unassigned"), "runner:one"), false);
  assert.equal(canRunnerMutate(run("assigned", "runner:two"), "runner:one"), false);
  assert.equal(canRunnerMutate(run("assigned", "runner:one"), "runner:one"), true);
});

test("a run without an assigned runner cannot be mutated", () => {
  assert.equal(canRunnerMutate(run("assigned"), "runner:internal"), false);
  assert.equal(canRunnerMutate(run("assigned"), "runner:one"), false);
});
