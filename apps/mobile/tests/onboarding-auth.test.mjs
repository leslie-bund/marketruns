import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const auth = read("src/api/auth.ts");
const client = read("src/api/client.ts");
const participant = read("src/api/participant.ts");
const store = read("src/api/active-store.ts");
const kyc = read("app/onboarding/kyc.tsx");
const launch = read("app/index.tsx");
const recovery = read("app/device-reset.tsx");
const markets = read("app/markets.tsx");
const profile = read("app/onboarding/profile.tsx");
const sellerJoin = read("app/seller/join.tsx");
const roleGate = read("src/features/transaction-role.tsx");

test("pending KYC persists and polls the same participant instead of minting another id", () => {
  assert.match(kyc, /participantId: pending\.id/);
  assert.match(kyc, /await setActiveParticipant\(participant\);[\s\S]*kycStatus === "pending"/);
  assert.match(kyc, /setInterval\(\(\) => \{ void resumeRef\.current\(true\); \}/);
  assert.match(client, /participantId: input\.participantId \?\? newId\("participant"\)/);
  assert.doesNotMatch(kyc, /kycStatus === "pending"[\s\S]{0,250}kycStatus = "verified"/);
});

test("local expiry and every authenticated 401 clear the cached session", () => {
  assert.match(auth, /sessionCache\.expiresAt > Date\.now\(\)/);
  assert.match(auth, /AsyncStorage\.removeItem\(SESSION_KEY\)/);
  for (const source of [auth, client, read("src/api/payments.ts"), read("src/api/notifications.ts")]) {
    assert.match(source, /response\.status === 401 && authorization\.authorization/);
  }
  assert.doesNotMatch(client, /code === "session-expired" \|\| code === "session-invalid"/);
});

test("identity changes clear sessions and stores are participant+market scoped", () => {
  assert.match(participant, /cache\?\.id !== participant\?\.id\) await clearSession\(\)/);
  assert.match(store, /storageKey = \(owner: string, market: string\)/);
  assert.match(store, /store\.sellerParticipantId === owner/);
  assert.doesNotMatch(store, /DEMO_OWNER|LEGACY_STORAGE_KEY/);
  assert.match(store, /owner \? await AsyncStorage\.getItem/);
});

test("fresh and recovered launches restore a cached participant before showing signed in", () => {
  assert.match(launch, /Recover existing account/);
  assert.match(recovery, /getParticipant\(recoveredId\)/);
  assert.match(recovery, /setActiveParticipant\(recoveredParticipant\)/);
  assert.match(roleGate, /!participant \|\| !session \|\| participant\.role !== role \|\| !kycEligible/);
  assert.match(launch, /transactionReady \? <Pill active>✓ SIGNED IN/);
});

test("market entry and onboarding require joined membership and a loaded registry", () => {
  assert.match(client, /setActiveParticipant\(\{ \.\.\.participant, markets: \[\.\.\.new Set/);
  assert.match(markets, /joined && roleMatches && Boolean\(session\) && kycEligible/);
  assert.match(profile, /markets\.data\?\.find\(\(entry\) => entry\.id === market\)/);
  assert.match(profile, /!name\.trim\(\) \|\| !registeredMarket/);
});

test("authenticated seller forms never inherit the Amina demo values", () => {
  assert.match(sellerJoin, /useState\(""\)/);
  assert.doesNotMatch(sellerJoin, /useState\("Amina's Fresh Store"\)|Stall B14/);
  assert.match(client, /\/store`\);\n    return body\.store/);
});
