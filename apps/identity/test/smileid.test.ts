import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySessionToken } from "@market-runs/domain";
import { createIdentityApp } from "../src/app.js";
import { createMemoryStore } from "../src/dev-store.js";
import { createFaceVerifier } from "../src/face-verifier.js";
import { SmileIdClient, SmileIdFaceVerifier, smileIdConfig, type SmileIdConfig } from "../src/smileid/index.js";
import { DEV_SESSION_SECRET, type Env } from "../src/env.js";

/**
 * Smile ID quarantine tests — ALL HTTP is mocked (an injected FetchLike); no
 * request leaves the test process. Cross-checks the HMAC callback scheme
 * against an independent node:crypto computation, then drives the full async
 * lifecycle: submit → pending → callback/poll → verdict.
 */

const CONFIG: SmileIdConfig = {
  partnerId: "1234",
  apiKey: "test-api-key",
  environment: "sandbox",
  baseUrl: "https://testapi.smileidentity.com",
  callbackUrl: undefined,
  privacyNoticeUrl: "https://example.com/privacy",
};

const IMAGE_A = Buffer.alloc(256, 7).toString("base64");
const IMAGE_B = Buffer.alloc(256, 9).toString("base64");

/** Independent reference implementation of the documented callback scheme. */
function referenceCallbackSignature(timestamp: string): string {
  return createHmac("sha256", CONFIG.apiKey)
    .update(timestamp + CONFIG.partnerId + "sid_request")
    .digest("base64");
}

type Handler = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A scripted Smile ID API: token issuance, submissions, and a status board the test flips. */
function fakeSmileApi(opts: { failAuth?: boolean; statusBoard?: Map<string, string> } = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const board = opts.statusBoard ?? new Map<string, string>();
  let jobCounter = 0;
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/v3/token")) {
      if (opts.failAuth) return jsonResponse(401, { status: "Unauthorized", message: "bad key" });
      return jsonResponse(200, { token: `jwt-${calls.length}` });
    }
    if (url.includes("/v3/registration") || url.includes("/v3/authentication") || url.includes("/v3/biometric_kyc")) {
      const jobId = `job_${(jobCounter += 1).toString().padStart(4, "0")}`;
      board.set(jobId, "processing");
      return jsonResponse(202, { status: "accepted", message: "accepted", job_id: jobId, user_id: "p-1", created_at: new Date().toISOString() });
    }
    const statusMatch = /\/v3\/status\/([^/?]+)$/.exec(url);
    if (statusMatch) {
      const jobId = statusMatch[1]!;
      const status = board.get(jobId) ?? "not_found";
      const http = status === "processing" ? 202 : status === "not_found" ? 404 : 200;
      return jsonResponse(http, { status, job_id: jobId, user_id: "p-1", message: `job is ${status}`, created_at: new Date().toISOString() });
    }
    return jsonResponse(500, { status: "Internal Server Error", message: `unmocked: ${url}` });
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls, board };
}

function makeApp(fetchImpl: typeof fetch, env: Partial<Env> = {}) {
  const store = createMemoryStore();
  const verifier = new SmileIdFaceVerifier(new SmileIdClient(CONFIG, fetchImpl));
  const app = createIdentityApp({ store, faceVerifier: verifier, passkeyVerifier: null });
  type WireResponse = Omit<Response, "json"> & { json(): Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}, method?: string): Promise<WireResponse> =>
    app.fetch(
      new Request(`http://identity.test${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env as Env,
    ) as Promise<WireResponse>;
  return { store, call };
}

/** Drive the callback route the way Smile ID would (signed headers + payload). */
async function deliverCallback(
  call: ReturnType<typeof makeApp>["call"],
  payload: Record<string, unknown>,
  signature = referenceCallbackSignature("2026-03-02T16:24:35.573Z"),
  timestamp = "2026-03-02T16:24:35.573Z",
) {
  return call(
    "/callbacks/smileid",
    payload,
    { "Response-Timestamp": timestamp, "Response-Signature": signature },
  );
}

function callbackPayload(jobId: string, status: string, reason: string | null = null) {
  return {
    status,
    message: `job is ${status}`,
    reason,
    product: "smart_selfie_authentication",
    partner_params: { job_id: jobId, user_id: "p-1" },
  };
}

describe("SmileIdClient signing", () => {
  it("computes the documented callback signature (HMAC-SHA256 of timestamp+partner_id+sid_request, base64)", async () => {
    const client = new SmileIdClient(CONFIG, (async () => jsonResponse(200, {})) as typeof fetch);
    const timestamp = "2026-03-02T16:24:35.573Z";
    expect(await client.computeCallbackSignature(timestamp)).toBe(referenceCallbackSignature(timestamp));
  });

  it("verifies good callback signatures and rejects bad or missing ones", async () => {
    const client = new SmileIdClient(CONFIG, (async () => jsonResponse(200, {})) as typeof fetch);
    const timestamp = "2026-03-02T16:24:35.573Z";
    expect(await client.verifyCallbackSignature(timestamp, referenceCallbackSignature(timestamp))).toBe(true);
    expect(await client.verifyCallbackSignature(timestamp, referenceCallbackSignature("2025-01-01T00:00:00.000Z"))).toBe(false);
    expect(await client.verifyCallbackSignature(timestamp, null)).toBe(false);
    expect(await client.verifyCallbackSignature(null, referenceCallbackSignature(timestamp))).toBe(false);
  });

  it("sends token auth on job submissions: /v3/token then SmileID-Token + SmileID-Partner-ID headers", async () => {
    const { fetchImpl, calls } = fakeSmileApi();
    const client = new SmileIdClient(CONFIG, fetchImpl);
    const accepted = await client.submitAuthentication({
      userId: "p-1",
      selfie: new Uint8Array(256).fill(7),
      livenessImages: [],
      userDetails: { givenNames: "Amina", lastName: "Yusuf", email: "amina@example.com" },
    });
    expect(accepted.jobId).toMatch(/^job_/);
    const tokenCall = calls.find((c) => c.url.endsWith("/v3/token"));
    expect((tokenCall?.init?.headers as Record<string, string>)["smileid-partner-id"]).toBe("1234");
    const submitCall = calls.find((c) => c.url.includes("/v3/authentication"));
    const headers = submitCall?.init?.headers as Record<string, string>;
    expect(headers["SmileID-Partner-ID"]).toBe("1234");
    expect(headers["SmileID-Token"]).toMatch(/^jwt-/);
    expect(submitCall?.init?.body).toBeInstanceOf(FormData);
  });

  it("config selects sandbox vs production base URLs and requires keys", () => {
    expect(smileIdConfig({ SMILEID_PARTNER_ID: "1", SMILEID_API_KEY: "k" } as Env).baseUrl).toBe(
      "https://testapi.smileidentity.com",
    );
    expect(
      smileIdConfig({ SMILEID_PARTNER_ID: "1", SMILEID_API_KEY: "k", SMILEID_ENV: "production" } as Env).baseUrl,
    ).toBe("https://api.smileidentity.com");
    expect(() => smileIdConfig({} as Env)).toThrow(/SMILEID_PARTNER_ID/);
    expect(() => createFaceVerifier({ FACE_VERIFIER: "smileid" } as Env)).toThrow(/SMILEID_PARTNER_ID/);
    expect(createFaceVerifier({} as Env).modelVersion).toBe("stub-sha512-dev");
  });
});

describe("async face jobs (smileid mode)", () => {
  it("enroll → 202 pending → signed callback completes → enrollment row is vendor-held (NULL embedding)", async () => {
    const { fetchImpl, board } = fakeSmileApi();
    const { call, store } = makeApp(fetchImpl);

    const enrollRes = await call("/auth/face/enroll", { participantId: "p-1", role: "buyer", image: IMAGE_A });
    expect(enrollRes.status).toBe(202);
    const pending = await enrollRes.json();
    expect(pending.status).toBe("pending");
    expect(pending.kind).toBe("enrollment");
    expect(pending.jobId).toBeTruthy();
    // No enrollment yet — the vendor hasn't ruled.
    expect(store.enrollments.has("p-1")).toBe(false);

    const providerJobId = store.jobs.get(pending.jobId)?.providerJobId;
    expect(providerJobId).toBeTruthy();
    board.set(providerJobId!, "clear"); // (poll path would also see this; we drive the callback instead)

    const cb = await deliverCallback(call, callbackPayload(providerJobId!, "clear"));
    expect(cb.status).toBe(200);
    expect((await cb.json()).ok).toBe(true);

    const row = store.enrollments.get("p-1");
    expect(row).toBeTruthy();
    expect(row!.modelVersion).toBe("smileid-smartselfie-v3");
    expect(row!.providerRef).toBe("p-1");
    expect(row!.embeddingEncrypted).toBeNull();
    expect(row!.iv).toBeNull();
    expect(row!.authTag).toBeNull();

    const status = await call(`/auth/face/job/${pending.jobId}`);
    expect(status.status).toBe(200);
    expect((await status.json()).status).toBe("complete");
  });

  it("verify → 202 pending → poll finds clear → session issued; a second poll re-derives the same token", async () => {
    const { fetchImpl, board } = fakeSmileApi();
    const { call, store } = makeApp(fetchImpl);

    // Enroll + complete via callback.
    const enroll = await (await call("/auth/face/enroll", { participantId: "p-1", role: "seller", image: IMAGE_A })).json();
    const enrollJob = store.jobs.get(enroll.jobId)!;
    await deliverCallback(call, callbackPayload(enrollJob.providerJobId, "clear"));

    // Verify submits an authentication job and answers pending.
    const verifyRes = await call("/auth/face/verify", { participantId: "p-1", image: IMAGE_B });
    expect(verifyRes.status).toBe(202);
    const pendingVerify = await verifyRes.json();
    expect(pendingVerify.kind).toBe("authentication");
    expect(pendingVerify.status).toBe("pending");

    // Vendor finishes; the client's poll finalizes and collects the session.
    const authJob = store.jobs.get(pendingVerify.jobId)!;
    board.set(authJob.providerJobId, "clear");
    const collected = await call(`/auth/face/job/${pendingVerify.jobId}`);
    expect(collected.status).toBe(200);
    const done = await collected.json();
    expect(done.status).toBe("complete");
    expect(done.session).toBeTruthy();
    const parsed = await verifySessionToken(done.session.token, DEV_SESSION_SECRET);
    expect(parsed.ok && parsed.payload.participantId).toBe("p-1");
    expect(parsed.ok && parsed.payload.role).toBe("seller");
    expect(store.enrollments.get("p-1")?.lastVerifiedAt).not.toBeNull();
    expect(store.attempts.map((a) => a.outcome)).toEqual(["pass"]);

    // Repeat poll: same session, re-derived deterministically (token never stored).
    const again = await (await call(`/auth/face/job/${pendingVerify.jobId}`)).json();
    expect(again.session.token).toBe(done.session.token);
    expect(again.session.tokenId).toBe(done.session.tokenId);
  });

  it("failed verify job → 401 face-mismatch on poll, audited as fail with NULL bucket", async () => {
    const { fetchImpl, board } = fakeSmileApi();
    const { call, store } = makeApp(fetchImpl);
    const enroll = await (await call("/auth/face/enroll", { participantId: "p-1", role: "buyer", image: IMAGE_A })).json();
    await deliverCallback(call, callbackPayload(store.jobs.get(enroll.jobId)!.providerJobId, "clear"));

    const pendingVerify = await (await call("/auth/face/verify", { participantId: "p-1", image: IMAGE_B })).json();
    board.set(store.jobs.get(pendingVerify.jobId)!.providerJobId, "block");

    const res = await call(`/auth/face/job/${pendingVerify.jobId}`);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("face-mismatch");
    expect(store.attempts.at(-1)).toMatchObject({ outcome: "fail", similarityBucket: null });
    expect(store.sessions.size).toBe(0); // no session on failure
  });

  it("callback with a bad signature → 401 and the job stays pending", async () => {
    const { fetchImpl } = fakeSmileApi();
    const { call, store } = makeApp(fetchImpl);
    const enroll = await (await call("/auth/face/enroll", { participantId: "p-1", role: "buyer", image: IMAGE_A })).json();
    const providerJobId = store.jobs.get(enroll.jobId)!.providerJobId;

    const bad = await deliverCallback(call, callbackPayload(providerJobId, "clear"), "forged-signature");
    expect(bad.status).toBe(401);
    expect((await bad.json()).error).toBe("callback-invalid");
    expect(store.jobs.get(enroll.jobId)!.status).toBe("pending");
    expect(store.enrollments.has("p-1")).toBe(false);
  });

  it("callback for an unknown job is acked 200 (stops provider retries); double delivery is a no-op", async () => {
    const { fetchImpl } = fakeSmileApi();
    const { call, store } = makeApp(fetchImpl);
    const unknown = await deliverCallback(call, callbackPayload("job_9999", "clear"));
    expect(unknown.status).toBe(200);
    expect((await unknown.json()).reason).toBe("unknown-job");

    const enroll = await (await call("/auth/face/enroll", { participantId: "p-1", role: "buyer", image: IMAGE_A })).json();
    const providerJobId = store.jobs.get(enroll.jobId)!.providerJobId;
    expect((await deliverCallback(call, callbackPayload(providerJobId, "clear"))).status).toBe(200);
    const dupe = await deliverCallback(call, callbackPayload(providerJobId, "block")); // at-least-once, conflicting
    expect(dupe.status).toBe(200);
    expect(store.jobs.get(enroll.jobId)!.status).toBe("passed"); // first verdict stands
  });

  it("404s unknown job ids; verify 404s face-not-enrolled before submission", async () => {
    const { fetchImpl } = fakeSmileApi();
    const { call } = makeApp(fetchImpl);
    expect((await call("/auth/face/job/nope")).status).toBe(404);
    const res = await call("/auth/face/verify", { participantId: "ghost", image: IMAGE_A });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("face-not-enrolled");
  });

  it("KYC seam: verifyIdDocument submits Biometric KYC with country/id_type/id_number", async () => {
    const { fetchImpl, calls } = fakeSmileApi();
    const client = new SmileIdClient(CONFIG, fetchImpl);
    const accepted = await client.verifyIdDocument({
      userId: "p-1",
      selfie: new Uint8Array(256).fill(7),
      livenessImages: [],
      userDetails: { givenNames: "Amina", lastName: "Yusuf", email: "amina@example.com" },
      country: "NG",
      idType: "BVN",
      idNumber: "12345678901",
    });
    expect(accepted.jobId).toMatch(/^job_/);
    const kycCall = calls.find((c) => c.url.includes("/v3/biometric_kyc"));
    expect(kycCall).toBeTruthy();
    const form = kycCall!.init!.body as FormData;
    expect(form.get("country")).toBe("NG");
    expect(form.get("id_type")).toBe("BVN");
    expect(form.get("id_number")).toBe("12345678901");
  });

  it("provider submission failure answers 502 identity-unavailable (no silent pass)", async () => {
    const { fetchImpl } = fakeSmileApi({ failAuth: true });
    const { call, store } = makeApp(fetchImpl);
    const res = await call("/auth/face/enroll", { participantId: "p-1", role: "buyer", image: IMAGE_A });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("identity-unavailable");
    expect(store.jobs.size).toBe(0);
  });
});

describe("provider-mode mismatch guards", () => {
  it("verify in smileid mode against a self-held (stub) enrollment 409s honestly", async () => {
    const { fetchImpl } = fakeSmileApi();
    const { call, store } = makeApp(fetchImpl);
    // Simulate a self-held enrollment row (as the stub mode would have written).
    await store.upsertFaceEnrollment({
      participantId: "p-1",
      role: "buyer",
      embeddingEncrypted: new Uint8Array(8),
      iv: new Uint8Array(12),
      authTag: new Uint8Array(16),
      modelVersion: "stub-sha512-dev",
      providerRef: null,
      createdAt: new Date(),
      lastVerifiedAt: null,
    });
    const res = await call("/auth/face/verify", { participantId: "p-1", image: IMAGE_A });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("enrollment-provider-mismatch");
  });

  it("the stub path 409s on a vendor-held row instead of crashing on NULL embeddings", async () => {
    const store = createMemoryStore();
    const { StubFaceVerifier } = await import("../src/face-verifier.js");
    const app = createIdentityApp({ store, faceVerifier: new StubFaceVerifier(), passkeyVerifier: null });
    await store.upsertFaceEnrollment({
      participantId: "p-1",
      role: "buyer",
      embeddingEncrypted: null,
      iv: null,
      authTag: null,
      modelVersion: "smileid-smartselfie-v3",
      providerRef: "p-1",
      createdAt: new Date(),
      lastVerifiedAt: null,
    });
    const res = await app.fetch(
      new Request("http://identity.test/auth/face/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ participantId: "p-1", image: IMAGE_A }),
      }),
      {} as Env,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("enrollment-provider-mismatch");
  });

  it("callback routes 404 when no async provider is active (stub mode)", async () => {
    const store = createMemoryStore();
    const { StubFaceVerifier } = await import("../src/face-verifier.js");
    const app = createIdentityApp({ store, faceVerifier: new StubFaceVerifier(), passkeyVerifier: null });
    const res = await app.fetch(
      new Request("http://identity.test/callbacks/smileid", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      {} as Env,
    );
    expect(res.status).toBe(404);
  });
});
