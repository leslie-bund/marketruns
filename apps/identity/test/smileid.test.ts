import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BIOMETRIC_CONSENT_VERSION } from "@market-runs/proto";
import { createIdentityApp } from "../src/app.js";
import { createMemoryStore } from "../src/dev-store.js";
import { StubFaceVerifier, createFaceVerifier } from "../src/face-verifier.js";
import { SmileIdClient, SmileIdFaceVerifier, smileIdConfig, type SmileIdConfig } from "../src/smileid/index.js";
import type { Env } from "../src/env.js";

const CONFIG: SmileIdConfig = { partnerId: "1234", apiKey: "test-api-key", environment: "sandbox",
  baseUrl: "https://testapi.smileidentity.com", callbackUrl: undefined, privacyNoticeUrl: "https://example.com/privacy" };
const IMAGE_A = Buffer.alloc(256, 7).toString("base64");
const FRAMES = Array.from({ length: 7 }, (_, i) => Buffer.alloc(32, i + 1).toString("base64"));
const consent = { version: BIOMETRIC_CONSENT_VERSION, granted: true as const, grantedAt: Date.now() };
const document = { country: "NG", idType: "BVN" as const, idNumber: "12345678901" };
function signature(timestamp: string) { return createHmac("sha256", CONFIG.apiKey).update(timestamp + CONFIG.partnerId + "sid_request").digest("base64"); }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fakeApi() {
  const calls: { url: string; init: RequestInit | undefined }[] = []; const board = new Map<string, string>(); let n = 0;
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.endsWith("/v3/token")) return json(200, { token: "jwt-test" });
    if (url.includes("/v3/biometric_kyc") || url.includes("/v3/authentication")) {
      const id = `job_${++n}`; board.set(id, "processing"); return json(202, { job_id: id, user_id: "p-1" });
    }
    const match = /\/v3\/status\/([^/?]+)$/.exec(url);
    if (match) { const status = board.get(match[1]!) ?? "not_found"; return json(status === "processing" ? 202 : status === "not_found" ? 404 : 200,
      { status, message: status, full_name: "Amina Legal Yusuf" }); }
    return json(500, { message: `unmocked ${url}` });
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls, board };
}
function makeApp(fetchImpl: typeof fetch, env: Partial<Env> = {}, now?: () => Date) {
  const store = createMemoryStore(); const verifier = new SmileIdFaceVerifier(new SmileIdClient(CONFIG, fetchImpl));
  const app = createIdentityApp({ store, faceVerifier: verifier, localFaceVerifier: new StubFaceVerifier(), passkeyVerifier: null, ...(now ? { now } : {}) });
  type Wire = Omit<Response, "json"> & { json(): Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Wire> => app.fetch(new Request(`http://identity.test${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env as Env) as Promise<Wire>;
  return { store, call };
}
async function startEnrollment(call: ReturnType<typeof makeApp>["call"]) {
  const enrollmentProof = (await (await call("/auth/enrollment-proof", { participantId: "p-1", role: "seller", displayName: "Amina", kycStatus: "preverified" })).json()).enrollmentProof;
  const res = await call("/auth/face/enroll", { participantId: "p-1", enrollmentProof, image: IMAGE_A, livenessImages: FRAMES, consent, identityDocument: document });
  expect(res.status).toBe(202); return (await res.json()).jobId as string;
}
async function callback(call: ReturnType<typeof makeApp>["call"], jobId: string, status = "clear", extra: Record<string, unknown> = {}) {
  const timestamp = "2026-03-02T16:24:35.573Z";
  return call("/callbacks/smileid", { status, message: status, partner_params: { job_id: jobId, user_id: "p-1" }, ...extra },
    { "Response-Timestamp": timestamp, "Response-Signature": signature(timestamp) });
}
describe("Smile ID quarantine", () => {
  it("uses token auth, exact frames, versioned consent and Biometric KYC fields", async () => {
    const { fetchImpl, calls } = fakeApi(); const client = new SmileIdClient(CONFIG, fetchImpl);
    await client.verifyIdDocument({ userId: "p-1", selfie: Buffer.alloc(32), livenessImages: FRAMES.map((f) => Buffer.from(f, "base64")),
      userDetails: { givenNames: "Amina", lastName: "Yusuf" }, ...document, consent });
    const submit = calls.find((c) => c.url.includes("biometric_kyc")); const form = submit?.init?.body as FormData;
    expect(form.getAll("liveness_images")).toHaveLength(7); expect(form.get("id_type")).toBe("BVN");
    expect(JSON.parse(String(form.get("consent"))).consent_version).toBe(BIOMETRIC_CONSENT_VERSION);
    expect((submit?.init?.headers as Record<string, string>)["SmileID-Token"]).toBe("jwt-test");
  });
  it("requires production vendor keys and does not silently select stub in production", () => {
    expect(smileIdConfig({ SMILEID_PARTNER_ID: "1", SMILEID_API_KEY: "k", SMILEID_ENV: "production" } as Env).baseUrl).toBe("https://api.smileidentity.com");
    expect(() => createFaceVerifier({ FACE_VERIFIER: "stub", IDENTITY_ENV: "production" } as Env)).toThrow(/forbidden/);
  });
});
describe("hybrid Biometric KYC enrollment", () => {
  it("finalizes providerRef AND encrypted local embedding, with immutable legal name and editable prefill", async () => {
    const { fetchImpl } = fakeApi(); const { call, store } = makeApp(fetchImpl); const id = await startEnrollment(call);
    const providerId = store.jobs.get(id)!.providerJobId;
    const cb = await callback(call, providerId, "clear", { first_name: "Amina", last_name: "Yusuf" }); expect(cb.status).toBe(200);
    const row = store.enrollments.get("p-1")!; expect(row.providerRef).toBe("p-1"); expect(row.embeddingEncrypted).toBeTruthy();
    expect(row.modelVersion).toBe("stub-sha512-dev"); expect(store.participants.get("p-1")?.verifiedLegalName).toBe("Amina Yusuf");
    expect(store.participants.get("p-1")?.displayName).toBe("Amina");
    await store.updateDisplayName("p-1", "Mina", new Date()); await store.completeIdentityKyc("p-1", "Different Legal", new Date());
    expect(store.participants.get("p-1")?.verifiedLegalName).toBe("Amina Yusuf"); expect(store.participants.get("p-1")?.displayName).toBe("Mina");
    const complete = await (await call(`/auth/face/job/${id}`)).json(); expect(complete.suggestedDisplayName).toBe("Amina Yusuf"); expect(complete.session).toBeTruthy();
  });
  it("supports full_name and callback image fallback without retaining the image", async () => {
    const { fetchImpl } = fakeApi(); const { call, store } = makeApp(fetchImpl); const id = await startEnrollment(call);
    const job = store.jobs.get(id)!; Object.assign(job, { pendingEmbeddingEncrypted: null, pendingEmbeddingIv: null, pendingEmbeddingAuthTag: null });
    await callback(call, job.providerJobId, "clear", { full_name: "Amina Legal Yusuf", image: IMAGE_A });
    expect(store.enrollments.get("p-1")?.embeddingEncrypted).toBeTruthy();
    expect(JSON.stringify([...store.jobs.values()])).not.toContain(IMAGE_A);
  });
  it("rejects forged signatures, wrong participant refs and expired jobs", async () => {
    let clock = new Date("2026-01-01T00:00:00Z"); consent.grantedAt = clock.getTime();
    const { fetchImpl } = fakeApi(); const { call, store } = makeApp(fetchImpl, {}, () => clock);
    const id = await startEnrollment(call); const providerId = store.jobs.get(id)!.providerJobId;
    expect((await call("/callbacks/smileid", {}, { "Response-Timestamp": "x", "Response-Signature": "bad" })).status).toBe(401);
    expect((await callback(call, providerId, "clear", { partner_params: { job_id: providerId, user_id: "attacker" } })).status).toBe(200);
    expect(store.enrollments.has("p-1")).toBe(false);
    const second = await startEnrollment(call); clock = new Date(clock.getTime() + 3 * 60_000);
    expect((await call(`/auth/face/job/${second}`)).status).toBe(410);
    const lateCallback = await callback(call, store.jobs.get(second)!.providerJobId);
    expect(lateCallback.status).toBe(200); expect((await lateCallback.json()).status).toBe("failed");
    expect(store.enrollments.has("p-1")).toBe(false);
    consent.grantedAt = Date.now();
  });
  it("login stays local 1:1 after hybrid enrollment", async () => {
    const { fetchImpl, calls } = fakeApi(); const { call, store } = makeApp(fetchImpl); const id = await startEnrollment(call);
    await callback(call, store.jobs.get(id)!.providerJobId); calls.length = 0;
    const ok = await call("/auth/face/verify", { participantId: "p-1", image: IMAGE_A, livenessImages: FRAMES, consent });
    expect(ok.status).toBe(200); expect(calls).toHaveLength(0);
  });
});
