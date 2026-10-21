import { describe, expect, it } from "vitest";
import { SESSION_TOKEN_TTL_MS, verifySessionToken } from "@market-runs/domain";
import { createIdentityApp } from "../src/app.js";
import { createMemoryStore } from "../src/dev-store.js";
import { StubFaceVerifier } from "../src/face-verifier.js";
import { DevStubPasskeyVerifier } from "../src/passkey-verifier.js";
import { DEV_SESSION_SECRET, type Env } from "../src/env.js";

/**
 * Full lifecycle tests over the real route handlers with the in-memory
 * store — no database needed (the store seam), WebCrypto runs natively in
 * node.
 */

const IMAGE_A = Buffer.alloc(256, 7).toString("base64");
const IMAGE_B = Buffer.alloc(256, 9).toString("base64");

function makeApp(env: Partial<Env> = {}, passkey: "stub" | "off" = "off") {
  const store = createMemoryStore();
  const app = createIdentityApp({
    store,
    faceVerifier: new StubFaceVerifier(),
    passkeyVerifier: passkey === "stub" ? new DevStubPasskeyVerifier() : null,
  });
  /* undici-types (via "node") type Response.json() as unknown; tests assert on
     wire bodies, so the helper widens json() once instead of casting 25 times
     (the apps/payments tests cast per call site). */
  type WireResponse = Omit<Response, "json"> & { json(): Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}): Promise<WireResponse> =>
    app.fetch(
      new Request(`http://identity.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env as Env,
    ) as Promise<WireResponse>;
  return { app, store, call };
}

async function enroll(call: ReturnType<typeof makeApp>["call"], participantId = "p-1") {
  return call("/auth/face/enroll", { participantId, role: "buyer", image: IMAGE_A });
}

describe("face enroll + verify", () => {
  it("enrolls and verifies the same face, issuing a valid 12h session", async () => {
    const { call, store } = makeApp();
    const enrollRes = await enroll(call);
    expect(enrollRes.status).toBe(200);
    const enrolled = await enrollRes.json();
    expect(enrolled.enrolled).toBe(true);
    expect(enrolled.modelVersion).toBe("stub-sha512-dev");

    const verifyRes = await call("/auth/face/verify", { participantId: "p-1", image: IMAGE_A });
    expect(verifyRes.status).toBe(200);
    const { session } = await verifyRes.json();
    const result = await verifySessionToken(session.token, DEV_SESSION_SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.participantId).toBe("p-1");
      expect(result.payload.role).toBe("buyer");
      expect(result.payload.exp - result.payload.iat).toBe(SESSION_TOKEN_TTL_MS);
    }
    // Session recorded for revocation; lastVerifiedAt advanced; audit row written.
    expect(store.sessions.has(session.tokenId)).toBe(true);
    expect(store.enrollments.get("p-1")?.lastVerifiedAt).not.toBeNull();
    expect(store.attempts.map((a) => a.outcome)).toEqual(["pass"]);
  });

  it("rejects the wrong face with 401 and a banded (never raw) similarity", async () => {
    const { call, store } = makeApp();
    await enroll(call);
    const res = await call("/auth/face/verify", { participantId: "p-1", image: IMAGE_B });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("face-mismatch");
    expect(["low", "medium", "high"]).toContain(body.similarityBucket);
    expect(body.similarity).toBeUndefined();
    expect(store.attempts.at(-1)?.outcome).toBe("fail");
  });

  it("404s face-not-enrolled for unknown participants", async () => {
    const { call } = makeApp();
    const res = await call("/auth/face/verify", { participantId: "ghost", image: IMAGE_A });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("face-not-enrolled");
  });

  it("honors FACE_MATCH_THRESHOLD (an exact-match stub score passes any sane threshold)", async () => {
    const strict = makeApp({ FACE_MATCH_THRESHOLD: "0.99" });
    await enroll(strict.call);
    const res = await strict.call("/auth/face/verify", { participantId: "p-1", image: IMAGE_A });
    expect(res.status).toBe(200);
  });

  it("guards enrollment behind the internal seam when IDENTITY_INTERNAL_TOKEN is set", async () => {
    const { call } = makeApp({ IDENTITY_INTERNAL_TOKEN: "internal-secret" });
    expect((await enroll(call)).status).toBe(403);
    const ok = await call(
      "/auth/face/enroll",
      { participantId: "p-1", role: "buyer", image: IMAGE_A },
      { "x-identity-internal": "internal-secret" },
    );
    expect(ok.status).toBe(200);
  });
});

describe("session validation", () => {
  it("validates a live session and rejects garbage, revoked, and expired tokens", async () => {
    const { call, store } = makeApp();
    await enroll(call);
    const { session } = await (await call("/auth/face/verify", { participantId: "p-1", image: IMAGE_A })).json();

    const ok = await call("/auth/session/validate", { token: session.token });
    expect(ok.status).toBe(200);
    expect((await ok.json()).payload.participantId).toBe("p-1");

    expect((await call("/auth/session/validate", { token: "garbage" })).status).toBe(401);

    // Revoked in the registry → validate fails even though the HMAC verifies.
    await store.revokeAuthSessions("p-1", new Date());
    const revoked = await call("/auth/session/validate", { token: session.token });
    expect(revoked.status).toBe(401);
    expect((await revoked.json()).error).toBe("session-invalid");
  });
});

describe("device-key credentials", () => {
  it("registers, authenticates (issuing a session), and stores only the hash", async () => {
    const { call, store } = makeApp();
    const reg = await call("/auth/device-key/register", {
      participantId: "p-1",
      credentialType: "device-key",
      secret: "keychain-secret",
      deviceLabel: "Adaeze's phone",
    });
    expect(reg.status).toBe(200);
    const { credentialId } = await reg.json();
    expect(store.credentials[0]?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.credentials[0]?.secretHash).not.toContain("keychain-secret");

    const auth = await call("/auth/device-key/authenticate", {
      participantId: "p-1",
      credentialId,
      secret: "keychain-secret",
    });
    expect(auth.status).toBe(200);
    const { session } = await auth.json();
    // No face enrollment → dev-stage role fallback.
    const result = await verifySessionToken(session.token, DEV_SESSION_SECRET);
    expect(result.ok && result.payload.role).toBe("buyer");
  });

  it("rejects a wrong secret, unknown credential, and revoked credential", async () => {
    const { call, store } = makeApp();
    const { credentialId } = await (
      await call("/auth/device-key/register", { participantId: "p-1", credentialType: "device-key", secret: "s1" })
    ).json();
    expect(
      (await call("/auth/device-key/authenticate", { participantId: "p-1", credentialId, secret: "wrong" })).status,
    ).toBe(401);
    expect(
      (await call("/auth/device-key/authenticate", { participantId: "p-1", credentialId: "nope", secret: "s1" })).status,
    ).toBe(401);
    await store.revokeDeviceCredentials("p-1", new Date());
    const res = await call("/auth/device-key/authenticate", { participantId: "p-1", credentialId, secret: "s1" });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("credential-revoked");
  });

  it("409s on second registration by default; upserts when FIDO_UPSERT_ENABLED=true", async () => {
    const off = makeApp();
    await off.call("/auth/device-key/register", { participantId: "p-1", credentialType: "device-key", secret: "s1" });
    const dup = await off.call("/auth/device-key/register", {
      participantId: "p-1",
      credentialType: "device-key",
      secret: "s2",
    });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toBe("credential-exists");

    const on = makeApp({ FIDO_UPSERT_ENABLED: "true" });
    const first = await (
      await on.call("/auth/device-key/register", { participantId: "p-1", credentialType: "device-key", secret: "s1" })
    ).json();
    const second = await on.call("/auth/device-key/register", {
      participantId: "p-1",
      credentialType: "device-key",
      secret: "s2",
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    // Upsert replaced the row: old credential id is gone, new secret works.
    expect(secondBody.credentialId).not.toBe(first.credentialId);
    expect(on.store.credentials).toHaveLength(1);
    expect(
      (
        await on.call("/auth/device-key/authenticate", {
          participantId: "p-1",
          credentialId: secondBody.credentialId,
          secret: "s2",
        })
      ).status,
    ).toBe(200);
  });

  it("gates fido: 501 by default, lifecycle works with the dev stub enabled", async () => {
    const off = makeApp();
    const fidoOff = await off.call("/auth/device-key/register", {
      participantId: "p-1",
      credentialType: "fido",
      publicKey: "attestation-bytes",
    });
    expect(fidoOff.status).toBe(501);
    expect((await fidoOff.json()).error).toBe("fido-not-implemented");

    const on = makeApp({}, "stub");
    const reg = await on.call("/auth/device-key/register", {
      participantId: "p-1",
      credentialType: "fido",
      publicKey: "attestation-bytes",
    });
    expect(reg.status).toBe(200);
    const { credentialId } = await reg.json();
    const auth = await on.call("/auth/device-key/authenticate", {
      participantId: "p-1",
      credentialId,
      secret: "any-assertion", // dev stub performs NO signature verification
    });
    expect(auth.status).toBe(200);
  });
});

describe("device reset lifecycle", () => {
  it("request → approve revokes credentials and sessions; re-enrollment proceeds", async () => {
    const { call } = makeApp();
    await enroll(call);
    const { session } = await (await call("/auth/face/verify", { participantId: "p-1", image: IMAGE_A })).json();
    const { credentialId } = await (
      await call("/auth/device-key/register", { participantId: "p-1", credentialType: "device-key", secret: "s1" })
    ).json();

    const reset = await call("/auth/device-reset", { participantId: "p-1", reason: "lost my phone" });
    expect(reset.status).toBe(200);
    const { id, status } = await reset.json();
    expect(status).toBe("pending");

    const decision = await call(`/auth/device-reset/${id}/decision`, { decision: "approved" });
    expect(decision.status).toBe(200);
    const outcome = await decision.json();
    expect(outcome.status).toBe("approved");
    expect(outcome.revokedCredentials).toBe(1);
    expect(outcome.revokedSessions).toBe(1);

    // The old credential and session are dead.
    expect(
      (await call("/auth/device-key/authenticate", { participantId: "p-1", credentialId, secret: "s1" })).status,
    ).toBe(401);
    expect((await call("/auth/session/validate", { token: session.token })).status).toBe(401);

    // Re-registration on the replacement device works without the upsert toggle.
    const reReg = await call("/auth/device-key/register", {
      participantId: "p-1",
      credentialType: "device-key",
      secret: "new-device-secret",
    });
    expect(reReg.status).toBe(200);
  });

  it("rejects, 404s unknown ids, and 409s double resolution; decision route is internal-guarded", async () => {
    const { call } = makeApp({ IDENTITY_INTERNAL_TOKEN: "tok" });
    expect((await call(`/auth/device-reset/x/decision`, { decision: "approved" })).status).toBe(403);
    expect(
      (await call(`/auth/device-reset/unknown/decision`, { decision: "approved" }, { "x-identity-internal": "tok" }))
        .status,
    ).toBe(404);

    const { id } = await (await call("/auth/device-reset", { participantId: "p-1", reason: "stolen" })).json();
    const headers = { "x-identity-internal": "tok" };
    const reject = await call(`/auth/device-reset/${id}/decision`, { decision: "rejected" }, headers);
    expect(reject.status).toBe(200);
    expect((await reject.json()).status).toBe("rejected");
    const again = await call(`/auth/device-reset/${id}/decision`, { decision: "approved" }, headers);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("reset-already-resolved");
  });
});

describe("device reset queue (GET /auth/device-reset)", () => {
  it("lists the queue oldest-first with reasons, filters by status, and shows resolution", async () => {
    const { call } = makeApp();
    const first = await (await call("/auth/device-reset", { participantId: "p-1", reason: "lost my phone" })).json();
    const second = await (await call("/auth/device-reset", { participantId: "p-2", reason: "stolen at the market" })).json();

    const pending = await call("/auth/device-reset?status=pending");
    expect(pending.status).toBe(200);
    const body = await pending.json();
    expect(body.requests.map((r: { id: string }) => r.id)).toEqual([first.id, second.id]);
    expect(body.requests[0]).toMatchObject({
      participantId: "p-1",
      reason: "lost my phone",
      status: "pending",
      resolvedAt: null,
      resolvedBy: null,
    });

    // Resolve the first: the pending filter drops it; approved shows the audit fields.
    await call(`/auth/device-reset/${first.id}/decision`, { decision: "approved" });
    const after = await (await call("/auth/device-reset?status=pending")).json();
    expect(after.requests.map((r: { id: string }) => r.id)).toEqual([second.id]);
    const approved = await (await call("/auth/device-reset?status=approved")).json();
    expect(approved.requests[0].resolvedBy).toBe("local-dev-internal");
    expect(approved.requests[0].resolvedAt).not.toBeNull();

    // No filter returns the whole queue.
    const all = await (await call("/auth/device-reset")).json();
    expect(all.requests).toHaveLength(2);
  });

  it("400s on an unknown status filter", async () => {
    const { call } = makeApp();
    const res = await call("/auth/device-reset?status=maybe");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid-request");
  });

  it("guards the queue behind the internal seam when IDENTITY_INTERNAL_TOKEN is set", async () => {
    const { call } = makeApp({ IDENTITY_INTERNAL_TOKEN: "tok" });
    await call("/auth/device-reset", { participantId: "p-1", reason: "new phone" }); // the request route stays public
    expect((await call("/auth/device-reset?status=pending")).status).toBe(403);
    const ok = await call("/auth/device-reset?status=pending", undefined, { "x-identity-internal": "tok" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).requests).toHaveLength(1);
  });
});

describe("wire hygiene", () => {
  it("healthz works and bad bodies 400 with invalid-request", async () => {
    const { call, app } = makeApp();
    expect((await (await call("/healthz")).json()).service).toBe("market-runs-identity");
    const res = await app.fetch(
      new Request("http://identity.test/auth/face/verify", { method: "POST", body: "not json" }),
      {} as Env,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, unknown>).error).toBe("invalid-request");
  });
});
