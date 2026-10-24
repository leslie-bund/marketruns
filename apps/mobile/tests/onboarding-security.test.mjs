import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const kyc = readFileSync(new URL("../app/onboarding/kyc.tsx", import.meta.url), "utf8");
const face = readFileSync(new URL("../app/onboarding/face.tsx", import.meta.url), "utf8");
const client = readFileSync(new URL("../src/api/client.ts", import.meta.url), "utf8");

test("onboarding sends required contact and consent fields and preserves the proof envelope", () => {
  assert.match(kyc, /email:/);
  assert.match(kyc, /consentAt:/);
  assert.match(kyc, /consentVersion:/);
  assert.match(client, /Promise<ParticipantRecorded>/);
  assert.match(client, /return body;/);
});

test("onboarding KYC never uploads or publicly reads biometric captures", () => {
  assert.doesNotMatch(kyc, /uploadCapture|facialCaptureRef|r2:\/\/|captureUrl/);
  assert.doesNotMatch(client, /onboardParticipant[\s\S]*?facialCaptureRef[\s\S]*?Join another market/);
  assert.match(face, /enrollFace\(/);
});
