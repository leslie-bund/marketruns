import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const runnerHome = read("app/runner/index.tsx");
const payoutCard = read("src/features/seller/payout.tsx");
const payments = read("src/api/payments.ts");

test("runner home exposes payout setup for the resolved runner in every run state", () => {
  assert.match(runnerHome, /const runnerId = participant\?\.id \?\? identities\.runner\.id/);
  assert.match(runnerHome, /<PayoutAccountCard participantId=\{runnerId\} recipientRole="runner" \/>/);
  assert.equal(runnerHome.match(/\{payoutAccount\}/g)?.length, 3);
  assert.doesNotMatch(runnerHome, /savePayoutAccount|resolvePayoutAccount|revokePayoutAccount/);
});

test("runner setup reuses verify-then-save and session-scoped participant APIs", () => {
  for (const api of ["getPayoutAccount", "resolvePayoutAccount", "savePayoutAccount", "revokePayoutAccount"]) {
    assert.match(payoutCard, new RegExp(`\\b${api}\\b`));
  }
  assert.match(payoutCard, /receive \{recipientRole\} payouts/);
  assert.match(payoutCard, /Used for \{recipientRole\} payouts/);
  assert.match(payments, /headers: \{ "content-type": "application\/json", \.\.\.authorization, \.\.\.participantHeaders\(\)/);
  assert.match(payments, /const authorization = sessionHeaders\(\)/);
});
