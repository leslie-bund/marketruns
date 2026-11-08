import { fetchMock, runInDurableObject } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signSessionToken } from "@market-runs/domain";
import type { Participant } from "@market-runs/proto";
import { createApp, internalIdentityKycRoute } from "../src/app/app.js";
import type { Env } from "../src/config/env.js";
import { participantObjectName } from "../src/do/participant-do.js";
import { STATE_KEY } from "../src/do/state.js";
import { internalPost } from "../src/do/transport.js";
import { PostgresCoreRegistry } from "../src/registry/postgres.js";
import { canTransact, preverifiedTransactionsAllowed } from "../src/registry/index.js";
import { bindings, marketStub, readJson } from "./helpers.js";

const BASE = "http://edge";
const SESSION_SECRET = "deployed-identity-session-secret-at-least-32-chars";
const INTERNAL_TOKEN = "deployed-identity-internal-test-token";
const DATABASE_URL = "postgres://deployed-identity-test.invalid/market_runs";
const deployedUrls = {
  OPS_ARCHIVE_URL: "https://archive-staging.example.com",
  IDENTITY_URL: "https://identity-staging.example.com",
  PAYMENTS_URL: "https://payments-staging.example.com",
  NOTIFICATIONS_URL: "https://notifications-staging.example.com",
};
const deployedSecrets = {
  PAYMENTS_INTERNAL_TOKEN: "deployed-payments-internal-test-token",
  ARCHIVE_INTERNAL_TOKEN: "deployed-archive-internal-test-token",
  NOTIFICATION_INTERNAL_TOKEN: "deployed-notification-internal-test-token",
  ID_DOCUMENT_HMAC_SECRET: "deployed-document-hmac-test-secret",
  IDENTITY_SESSION_SECRET: SESSION_SECRET,
  IDENTITY_INTERNAL_TOKEN: INTERNAL_TOKEN,
  OPS_AUTH_SECRET: "deployed-ops-auth-test-secret-at-least-32-chars",
};

function deployedEnv(overrides: Record<string, unknown> = {}): Env {
  const values: Record<string, unknown> = {
    ...deployedUrls,
    ...deployedSecrets,
    EDGE_ENV: "staging",
    ALLOW_HEADER_AUTH: "false",
    DATABASE_URL,
    ...overrides,
  };
  return new Proxy(bindings, {
    get: (target, prop, receiver) =>
      typeof prop === "string" && prop in values ? values[prop] : Reflect.get(target, prop, receiver),
  }) as Env;
}

function onboardingCommand(participantId: string) {
  return {
    type: "participant.onboarded",
    participantId,
    role: "buyer",
    displayName: "Deployed Buyer",
    email: "deployed-buyer@example.com",
    consentAt: Date.now(),
    consentVersion: "kyc-onboarding-v1",
    idDocumentType: "bvn",
    idDocument: "12345678901",
    market: "Balogun",
  };
}

async function bearer(participantId: string, role: "buyer" | "seller" | "runner" = "buyer"): Promise<string> {
  const at = Date.now();
  return signSessionToken({
    tokenId: `session-${participantId}`,
    participantId,
    role,
    iat: at,
    exp: at + 60_000,
  }, SESSION_SECRET);
}

function postJson(path: string, body: unknown, env: Env, headers: Record<string, string> = {}): Promise<Response> {
  return createApp().fetch(new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), env);
}

function participantStub(participantId: string) {
  return bindings.PARTICIPANT_DO.get(bindings.PARTICIPANT_DO.idFromName(participantObjectName(participantId)));
}

let durableProfile: Participant | null;
let savedParticipants: Participant[];

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterAll(() => fetchMock.deactivate());
beforeEach(() => {
  durableProfile = null;
  savedParticipants = [];
  vi.spyOn(PostgresCoreRegistry.prototype, "listMarkets").mockResolvedValue([
    { id: "Balogun", name: "Balogun", opensAt: "08:00", closesAt: "18:00", onlineSellers: 0 },
  ]);
  vi.spyOn(PostgresCoreRegistry.prototype, "participant").mockImplementation(async (participantId) =>
    durableProfile?.id === participantId ? structuredClone(durableProfile) : null);
  vi.spyOn(PostgresCoreRegistry.prototype, "saveParticipant").mockImplementation(async (participant) => {
    durableProfile = structuredClone(participant);
    savedParticipants.push(structuredClone(participant));
  });
});
afterEach(() => vi.restoreAllMocks());

describe("deployed staging preverified transactions", () => {
  it("preverifies inside ParticipantDO with header auth false and accepts a real Bearer transaction", async () => {
    const participantId = "participant-staging-direct";
    const response = await runInDurableObject(participantStub(participantId), async (instance) => {
      (instance as unknown as { env: Env }).env = deployedEnv({ DATABASE_URL: "" });
      return instance.fetch(internalPost("/onboard", onboardingCommand(participantId)));
    });
    expect(response.status).toBe(200);
    const recorded = await readJson(response);
    durableProfile = recorded.participant as Participant;
    expect(durableProfile.kycStatus).toBe("preverified");
    expect(preverifiedTransactionsAllowed({ EDGE_ENV: "staging", ALLOW_HEADER_AUTH: "false" })).toBe(true);

    const token = await bearer(participantId);
    const intent = await postJson("/command", {
      type: "intent.posted",
      intentId: "intent-staging-preverified",
      market: "Balogun",
      shopItem: "Tomatoes",
      quantity: 2,
      unit: "kg",
      priceBand: { minKobo: 120_000, maxKobo: 180_000 },
    }, deployedEnv(), { authorization: `Bearer ${token}` });
    expect(intent.status).toBe(200);
  });

  it("joins the initial market and issues proof through command onboarding in deployed posture", async () => {
    const participantId = "participant-staging-command";
    fetchMock.get("https://identity-staging.example.com").intercept({
      path: "/auth/enrollment-proof",
      method: "POST",
    }).reply(200, {
      participantId,
      enrollmentProof: "p".repeat(64),
      kycStatus: "preverified",
      displayName: "Deployed Buyer",
      verifiedLegalName: null,
      expiresAt: Date.now() + 60_000,
    });
    const token = await bearer(participantId);
    const response = await postJson("/command", onboardingCommand(participantId), deployedEnv(), {
      authorization: `Bearer ${token}`,
    });
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.enrollmentProof).toBe("p".repeat(64));
    expect((body.participant as Participant).kycStatus).toBe("preverified");
    const members = await readJson(await marketStub("Balogun").fetch(new Request("http://do/members")));
    expect((members.members as Array<{ participantId: string }>).some((member) => member.participantId === participantId)).toBe(true);
  });

  it("allows only verified KYC in production even if the legacy flag is present", () => {
    const env = { EDGE_ENV: "production", ALLOW_HEADER_AUTH: "true" };
    expect(preverifiedTransactionsAllowed(env)).toBe(false);
    expect(canTransact("preverified", preverifiedTransactionsAllowed(env))).toBe(false);
    expect(canTransact("verified", preverifiedTransactionsAllowed(env))).toBe(true);
  });
});

describe("internal identity KYC reconciliation", () => {
  const participantId = "participant-identity-reconciliation";
  const pending: Participant = {
    id: participantId,
    role: "seller",
    displayName: "Pending Seller",
    email: "pending-seller@example.com",
    kycStatus: "pending",
    idDocumentType: "nin",
    idDocumentHash: "ab".repeat(32),
    consentAt: 1_761_000_000_000,
    consentVersion: "kyc-onboarding-v1",
    markets: ["Balogun"],
    createdAt: 1_761_000_000_000,
  };

  it("fails closed for missing deployed configuration and token mismatches", async () => {
    const missing = await internalIdentityKycRoute().fetch(new Request("http://edge/kyc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participantId, verifiedLegalName: null }),
    }), deployedEnv({ IDENTITY_INTERNAL_TOKEN: undefined }));
    expect(missing.status).toBe(503);
    expect((await readJson(missing)).error).toBe("identity-auth-unconfigured");

    await runInDurableObject(participantStub(participantId), async (_instance, state) => {
      await state.storage.put(STATE_KEY, pending);
    });
    const mismatch = await postJson("/internal/identity/kyc", {
      participantId,
      verifiedLegalName: "Amina Legal Yusuf",
    }, deployedEnv(), { "x-identity-internal": "wrong-token" });
    expect(mismatch.status).toBe(403);
    expect(savedParticipants).toHaveLength(0);
    const unchanged = await participantStub(participantId).fetch(new Request(`http://do/participant/${participantId}`));
    expect(((await readJson(unchanged)).participant as Participant).kycStatus).toBe("pending");
  });

  it("upgrades only KYC fields, updates the registry, and is idempotent without clearing a legal name", async () => {
    await runInDurableObject(participantStub(participantId), async (_instance, state) => {
      await state.storage.put(STATE_KEY, pending);
    });
    const request = (verifiedLegalName: string | null) => postJson("/internal/identity/kyc", {
      participantId,
      verifiedLegalName,
    }, deployedEnv(), { "x-identity-internal": INTERNAL_TOKEN });

    const first = await request("Amina Legal Yusuf");
    expect(first.status).toBe(200);
    const recorded = (await readJson(first)).participant as Participant;
    expect(recorded).toEqual({ ...pending, kycStatus: "verified", verifiedLegalName: "Amina Legal Yusuf" });
    expect(savedParticipants.at(-1)).toEqual(recorded);

    const retry = await request("Amina Legal Yusuf");
    expect(retry.status).toBe(200);
    expect((await readJson(retry)).participant).toEqual(recorded);
    const nullRetry = await request(null);
    expect(nullRetry.status).toBe(200);
    expect((await readJson(nullRetry)).participant).toEqual(recorded);

    const stored = await participantStub(participantId).fetch(new Request(`http://do/participant/${participantId}`));
    expect((await readJson(stored)).participant).toEqual(recorded);
    expect(savedParticipants).toHaveLength(3);
  });
});
