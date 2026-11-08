import { describe, expect, it } from "vitest";
import { verifySessionToken } from "@market-runs/domain";
import { BIOMETRIC_CONSENT_VERSION } from "@market-runs/proto";
import { createIdentityApp } from "../src/app.js";
import { createMemoryStore } from "../src/dev-store.js";
import { StubFaceVerifier } from "../src/face-verifier.js";
import { DevStubPasskeyVerifier } from "../src/passkey-verifier.js";
import { DEV_SESSION_SECRET, type Env } from "../src/env.js";

const IMAGE_A = Buffer.alloc(256, 7).toString("base64");
const IMAGE_B = Buffer.alloc(256, 9).toString("base64");
const FRAMES = Array.from({ length: 7 }, (_, i) => Buffer.alloc(32, i + 1).toString("base64"));
const consent = () => ({ version: BIOMETRIC_CONSENT_VERSION, granted: true as const, grantedAt: Date.now() });
const STAGING_SECRETS = {
  IDENTITY_INTERNAL_TOKEN: "i".repeat(32),
  IDENTITY_SESSION_SECRET: "s".repeat(32),
  IDENTITY_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
} satisfies Partial<Env>;
function makeApp(env: Partial<Env> = {}, passkey = false) {
  const store = createMemoryStore();
  const app = createIdentityApp({ store, faceVerifier: new StubFaceVerifier(), passkeyVerifier: passkey ? new DevStubPasskeyVerifier() : null });
  type Wire = Omit<Response, "json"> & { json(): Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}, method?: string): Promise<Wire> => app.fetch(new Request(`http://identity.test${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      ...(env.IDENTITY_INTERNAL_TOKEN ? { "x-identity-internal": env.IDENTITY_INTERNAL_TOKEN } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env as Env) as Promise<Wire>;
  return { store, call };
}
async function proof(call: ReturnType<typeof makeApp>["call"], participantId = "p-1", kycStatus: "preverified" | "verified" = "verified") {
  const res = await call("/auth/enrollment-proof", { participantId, role: "buyer", displayName: "Amina", kycStatus });
  expect(res.status).toBe(200); return (await res.json()).enrollmentProof as string;
}
async function enroll(call: ReturnType<typeof makeApp>["call"], participantId = "p-1") {
  const enrollmentProof = await proof(call, participantId);
  const res = await call("/auth/face/enroll", { participantId, enrollmentProof, image: IMAGE_A, livenessImages: FRAMES, consent: consent() });
  return { res, enrollmentProof };
}
describe("proof-bound enrollment and login", () => {
  it("cannot enroll an arbitrary participant; bound proof produces a hybrid-ready local enrollment", async () => {
    const { call, store } = makeApp();
    expect((await call("/auth/face/enroll", { participantId: "attacker", enrollmentProof: "x".repeat(64), image: IMAGE_A, livenessImages: FRAMES, consent: consent() })).status).toBe(401);
    const { res } = await enroll(call); expect(res.status).toBe(200);
    const body = await res.json(); expect(body.enrolled).toBe(true); expect(body.session).toBeTruthy();
    expect(store.enrollments.get("p-1")?.embeddingEncrypted).toBeTruthy();
    expect(store.participants.get("p-1")?.kycStatus).toBe("verified"); expect(store.consents).toHaveLength(1);
  });
  it("rejects proof participant swapping, missing frames, and stale consent", async () => {
    const { call } = makeApp(); const enrollmentProof = await proof(call);
    const wrong = await call("/auth/face/enroll", { participantId: "p-2", enrollmentProof, image: IMAGE_A, livenessImages: FRAMES, consent: consent() });
    expect(wrong.status).toBe(401);
    expect((await call("/auth/face/enroll", { participantId: "p-1", enrollmentProof, image: IMAGE_A, livenessImages: FRAMES.slice(0, 5), consent: consent() })).status).toBe(400);
    const stale = await call("/auth/face/enroll", { participantId: "p-1", enrollmentProof, image: IMAGE_A, livenessImages: FRAMES,
      consent: { ...consent(), grantedAt: Date.now() - 20 * 60_000 } }); expect(stale.status).toBe(400);
  });
  it("verifies only 1:1, issues a valid session, and never exposes a raw score", async () => {
    const { call, store } = makeApp(); await enroll(call);
    const ok = await call("/auth/face/verify", { participantId: "p-1", image: IMAGE_A, livenessImages: FRAMES, consent: consent() });
    expect(ok.status).toBe(200); const { session } = await ok.json();
    const parsed = await verifySessionToken(session.token, DEV_SESSION_SECRET); expect(parsed.ok && parsed.payload.participantId).toBe("p-1");
    const bad = await call("/auth/face/verify", { participantId: "p-1", image: IMAGE_B, livenessImages: FRAMES, consent: consent() });
    expect(bad.status).toBe(401); const body = await bad.json(); expect(body.similarity).toBeUndefined(); expect(body.similarityBucket).toBeTruthy();
    expect(store.attempts.at(-1)?.outcome).toBe("fail");
  });
  it("fails closed after five failed attempts", async () => {
    const { call } = makeApp(); await enroll(call);
    for (let i = 0; i < 5; i++) await call("/auth/face/verify", { participantId: "p-1", image: IMAGE_B, livenessImages: FRAMES, consent: consent() });
    const limited = await call("/auth/face/verify", { participantId: "p-1", image: IMAGE_A, livenessImages: FRAMES, consent: consent() });
    expect(limited.status).toBe(429); expect((await limited.json()).error).toBe("too-many-attempts");
  });
  it("keeps staging preverified distinct and preserves the production KYC gate", async () => {
    const staging = makeApp({ IDENTITY_ENV: "staging", ...STAGING_SECRETS }); const preverified = await proof(staging.call, "p-stage", "preverified");
    expect((await staging.call("/auth/face/enroll", { participantId: "p-stage", enrollmentProof: preverified, image: IMAGE_A, livenessImages: FRAMES, consent: consent() })).status).toBe(200);
    const production = makeApp({ IDENTITY_ENV: "production", IDENTITY_INTERNAL_TOKEN: "i".repeat(32), IDENTITY_SESSION_SECRET: "s".repeat(32), IDENTITY_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") });
    expect((await production.call("/auth/enrollment-proof", { participantId: "p-1", role: "buyer", displayName: "A", kycStatus: "preverified" }, { "x-identity-internal": "i".repeat(32) })).status).toBe(403);
  });
  it("requires internal authentication for enrollment and fails closed when staging omits its token", async () => {
    const secured = makeApp({ IDENTITY_INTERNAL_TOKEN: "secret" });
    const enrollmentProof = await proof(secured.call);
    const body = { participantId: "p-1", enrollmentProof, image: IMAGE_A, livenessImages: FRAMES, consent: consent() };
    expect((await secured.call("/auth/face/enroll", body, { "x-identity-internal": "wrong" })).status).toBe(403);
    expect((await secured.call("/auth/face/enroll", body)).status).toBe(200);

    const missingToken = makeApp({
      IDENTITY_ENV: "staging",
      IDENTITY_SESSION_SECRET: STAGING_SECRETS.IDENTITY_SESSION_SECRET,
      IDENTITY_ENCRYPTION_KEY: STAGING_SECRETS.IDENTITY_ENCRYPTION_KEY,
    });
    expect((await missingToken.call("/auth/enrollment-proof", {
      participantId: "p-stage", role: "buyer", displayName: "Amina", kycStatus: "preverified",
    })).status).toBe(503);
  });
  it("rejects duplicate identity proof requests that attempt to change role", async () => {
    const { call, store } = makeApp({ IDENTITY_ENV: "staging", ...STAGING_SECRETS });
    await proof(call, "p-fixed-role", "preverified");
    const duplicate = await call("/auth/enrollment-proof", { participantId: "p-fixed-role", role: "runner", displayName: "Amina", kycStatus: "preverified" });
    expect(duplicate.status).toBe(409);
    expect(store.participants.get("p-fixed-role")?.role).toBe("buyer");
  });
});
describe("device credentials and recovery", () => {
  it("requires proof or same-participant session for registration and consumes proof", async () => {
    const { call } = makeApp(); const { enrollmentProof } = await enroll(call);
    expect((await call("/auth/device-key/register", { participantId: "p-1", credentialType: "device-key", secret: "s".repeat(32) })).status).toBe(401);
  });
  it("registers with the enrollment proof, authenticates, and blocks proof reuse", async () => {
    const { call, store } = makeApp(); const { enrollmentProof } = await enroll(call);
    const reg = await call("/auth/device-key/register", { participantId: "p-1", enrollmentProof, credentialType: "device-key", secret: "s".repeat(32) });
    expect(reg.status).toBe(200); const { credentialId } = await reg.json(); expect(store.credentials[0]?.secretHash).not.toContain("s".repeat(32));
    expect((await call("/auth/device-key/authenticate", { participantId: "p-1", credentialId, secret: "s".repeat(32) })).status).toBe(200);
    expect((await call("/auth/device-key/register", { participantId: "p-1", enrollmentProof, credentialType: "device-key", secret: "t".repeat(32) })).status).toBe(409);
  });
  it("recovery needs fresh liveness + 1:1 and revokes old credentials and sessions", async () => {
    const { call } = makeApp(); const { res, enrollmentProof } = await enroll(call); const oldSession = (await res.json()).session;
    const { credentialId } = await (await call("/auth/device-key/register", { participantId: "p-1", enrollmentProof, credentialType: "device-key", secret: "s".repeat(32) })).json();
    expect((await call("/auth/recovery", { participantId: "p-1", image: IMAGE_B, livenessImages: FRAMES, consent: consent(), credentialType: "device-key", secret: "n".repeat(32) })).status).toBe(401);
    const recovered = await call("/auth/recovery", { participantId: "p-1", image: IMAGE_A, livenessImages: FRAMES, consent: consent(), credentialType: "device-key", secret: "n".repeat(32) });
    expect(recovered.status).toBe(200); const body = await recovered.json();
    expect((await call("/auth/session/validate", { token: oldSession.token })).status).toBe(401);
    expect((await call("/auth/device-key/authenticate", { participantId: "p-1", credentialId, secret: "s".repeat(32) })).status).toBe(401);
    expect((await call("/auth/device-key/authenticate", { participantId: "p-1", credentialId: body.credentialId, secret: "n".repeat(32) })).status).toBe(200);
  });
  it("public callers cannot create an ops reset", async () => {
    const { call } = makeApp({ IDENTITY_INTERNAL_TOKEN: "secret" });
    expect((await call("/auth/device-reset", { participantId: "p-1", reason: "lost" }, { "x-identity-internal": "wrong" })).status).toBe(403);
  });
  it("retains the dev FIDO gate behind the same proof requirement", async () => {
    const { call } = makeApp({}, true); const enrollmentProof = await proof(call);
    const res = await call("/auth/device-key/register", { participantId: "p-1", enrollmentProof, credentialType: "fido", publicKey: "attestation" });
    expect(res.status).toBe(200);
  });
});
describe("profile and production secrets", () => {
  it("edits displayName without exposing a legal-name mutation", async () => {
    const { call, store } = makeApp(); const { res } = await enroll(call); const { session } = await res.json();
    await store.completeIdentityKyc("p-1", "Amina Legal Yusuf", new Date());
    const changed = await call("/auth/identity/p-1/display-name", { displayName: "Mina" }, { authorization: `Bearer ${session.token}` }, "PATCH");
    expect(changed.status).toBe(200); expect(store.participants.get("p-1")?.displayName).toBe("Mina");
    expect(store.participants.get("p-1")?.verifiedLegalName).toBe("Amina Legal Yusuf");
    expect((await call("/auth/identity/p-1/display-name", { displayName: "Attacker" }, {}, "PATCH")).status).toBe(401);
  });
  it("has no production public secret fallback", async () => {
    const { call } = makeApp({ IDENTITY_ENV: "production", IDENTITY_INTERNAL_TOKEN: "token" });
    const res = await call("/auth/session/validate", { token: "anything" });
    expect(res.status).toBe(500);
  });
});
