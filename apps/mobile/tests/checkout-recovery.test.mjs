import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkoutRecoveryRunId } from "../src/features/buyer/checkout-recovery.ts";

const checkoutScreen = readFileSync(new URL("../app/buyer/checkout.tsx", import.meta.url), "utf8");

test("a checkout tombstone recovers only its server-issued run id", () => {
  const error = {
    status: 409,
    code: "cart-already-checked-out",
    details: { runId: "run:cart:Balogun:buyer:one", retiredAt: 123 },
  };
  assert.equal(checkoutRecoveryRunId(error), "run:cart:Balogun:buyer:one");
});

test("other checkout errors and malformed tombstones remain ordinary failures", () => {
  assert.equal(checkoutRecoveryRunId({ status: 409, code: "payment-hold-insufficient", details: { runId: "run:wrong" } }), null);
  assert.equal(checkoutRecoveryRunId({ status: 500, code: "cart-already-checked-out", details: { runId: "run:wrong" } }), null);
  assert.equal(checkoutRecoveryRunId({ status: 409, code: "cart-already-checked-out", details: {} }), null);
  assert.equal(checkoutRecoveryRunId({ status: 409, code: "cart-already-checked-out", details: { runId: "" } }), null);
  assert.equal(checkoutRecoveryRunId(new Error("network unavailable")), null);
});

test("paid and unpaid checkout both record and open the recovered run", () => {
  assert.match(checkoutScreen, /if \(await recoverCheckout\(error, clearPayment\)\) return;/);
  assert.match(checkoutScreen, /if \(await recoverCheckout\(error\)\) return;/);
  assert.match(checkoutScreen, /await recordRunId\(getActiveMarket\(\), runId\)/);
  assert.match(checkoutScreen, /router\.replace\(\{ pathname: "\/buyer\/run", params: \{ runId \} \}\)/);
});
