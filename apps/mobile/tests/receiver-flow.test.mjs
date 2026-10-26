import assert from "node:assert/strict";
import test from "node:test";
import { createHandoffPayload, parseHandoffPayload } from "../src/features/run/handoff-payload.ts";
import { buyerCanConfirm, deliveryReceiverLabel, receiverSelection } from "../src/features/run/receiver-state.ts";

test("handoff QR round-trips the server challenge and rejects bare ids or malformed payloads", () => {
  const input = { runId: "run:cart:Balogun:buyer:one", handoffId: "handoff:one", challenge: "signed challenge/+" };
  assert.deepEqual(parseHandoffPayload(createHandoffPayload(input)), input);
  assert.equal(parseHandoffPayload("market-runs:handoff:handoff:one"), null);
  assert.equal(parseHandoffPayload("market-runs:handoff:v1:%7B%7D"), null);
});

test("receiver selection trims delegated names and rejects an empty designation", () => {
  assert.deepEqual(receiverSelection("buyer", "ignored"), { kind: "buyer" });
  assert.deepEqual(receiverSelection("designated", "  Ada Receiver  "), { kind: "designated", name: "Ada Receiver" });
  assert.throws(() => receiverSelection("designated", "  "), /name/i);
});

test("buyer confirmation needs a fresh photographed, code-verified delivery and Me receiver state", () => {
  const run = { receiver: { kind: "buyer" } };
  const handoff = { type: "delivery", status: "pending", scannedAt: 10, photoCapturedAt: 10 };
  assert.equal(buyerCanConfirm(handoff, run), true);
  assert.equal(buyerCanConfirm({ ...handoff, photoCapturedAt: 9 }, run), false);
  assert.equal(buyerCanConfirm(handoff, { receiver: { kind: "designated", name: "Ada" } }), false);
  assert.equal(deliveryReceiverLabel({ receiver: { kind: "designated", name: "Ada" } }), "Ada");
});
