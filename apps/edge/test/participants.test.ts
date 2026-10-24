import { SELF, env, fetchMock, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindings, marketStub, readJson } from "./helpers.js";
import { LEGACY_REGISTRY_NAME, participantObjectName } from "../src/do/participant-do.js";
import { STATE_KEY } from "../src/do/state.js";
import type { Env } from "../src/config/env.js";

/** Staging onboarding returns preverified plus a proof from the internal identity seam. */
const BASE = "http://edge";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock.get("http://localhost:8789").intercept({ path: "/auth/enrollment-proof", method: "POST" }).reply(200, (opts) => {
    const input = JSON.parse(String(opts.body)) as { participantId: string; displayName: string; kycStatus: "preverified" };
    return { ...input, enrollmentProof: "p".repeat(64), verifiedLegalName: null, expiresAt: Date.now() + 60_000 };
  }).persist();
});
afterAll(() => fetchMock.deactivate());

async function postCommand(body: unknown): Promise<Response> {
  const input = body as Record<string, unknown>;
  const wire = input.type === "participant.onboarded" ? {
    email: "participant@example.com",
    consentAt: Date.now(),
    consentVersion: "kyc-onboarding-v1",
    ...input,
  } : body;
  return SELF.fetch(new Request(`${BASE}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(wire),
  }));
}

describe("participant onboarding and market membership", () => {
  it("verifies a well-formed onboarding, records the member, and indexes the market", async () => {
    const response = await postCommand({
      type: "participant.onboarded",
      participantId: "participant-amina",
      role: "seller",
      displayName: "Amina",
      idDocumentType: "bvn",
      idDocument: "12345678901",
      facialCaptureRef: "r2://archive/captures/face-1.jpg",
      market: "Balogun",
    });
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.type).toBe("participant.recorded");
    const participant = body.participant as { kycStatus: string; markets: string[]; idDocumentHash: string };
    expect(participant.kycStatus).toBe("preverified");
    expect(participant.markets).toEqual(["Balogun"]);
    // The raw document number never persists — only its SHA-256 hash.
    expect(participant.idDocumentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toContain("12345678901");

    const members = await marketStub("Balogun").fetch(new Request("http://do/members"));
    const memberList = (await readJson(members)).members as Array<{ participantId: string; role: string }>;
    expect(memberList.some((member) => member.participantId === "participant-amina" && member.role === "seller")).toBe(true);

    const markets = await SELF.fetch(new Request(`${BASE}/markets`));
    const index = (await readJson(markets)).markets as Array<{ id: string }>;
    expect(index.some((market) => market.id === "Balogun")).toBe(true);
  });

  it("fails malformed documents and never joins the market", async () => {
    const response = await postCommand({
      type: "participant.onboarded",
      participantId: "participant-bad",
      role: "buyer",
      displayName: "Bad Doc",
      idDocumentType: "nin",
      idDocument: "12345",
      facialCaptureRef: "r2://archive/captures/face-2.jpg",
      market: "Balogun",
    });
    expect(response.status).toBe(400);
    const profile = await SELF.fetch(new Request(`${BASE}/participants/participant-bad`));
    expect(profile.status).toBe(404);

    const members = await marketStub("Balogun").fetch(new Request("http://do/members"));
    const memberList = (await readJson(members)).members as Array<{ participantId: string }>;
    expect(memberList.some((member) => member.participantId === "participant-bad")).toBe(false);
  });

  it("joins additional markets idempotently", async () => {
    const join = () =>
      postCommand({ type: "market.joined", market: "Computer Village", participantId: "participant-amina", role: "seller" });
    expect((await join()).status).toBe(200);
    expect((await join()).status).toBe(200);

    const members = await marketStub("Computer Village").fetch(new Request("http://do/members"));
    const memberList = (await readJson(members)).members as Array<{ participantId: string }>;
    expect(memberList.filter((member) => member.participantId === "participant-amina").length).toBe(1);

    const profile = await SELF.fetch(new Request(`${BASE}/participants/participant-amina`));
    const participant = (await readJson(profile)).participant as { markets: string[] };
    expect(participant.markets).toContain("Computer Village");

    const markets = await SELF.fetch(new Request(`${BASE}/markets`));
    const index = (await readJson(markets)).markets as Array<{ id: string }>;
    expect(index.some((market) => market.id === "Computer Village")).toBe(true);
  });
});

/**
 * Per-participant keying (`participant:<participantId>`): each participant is
 * their own Durable Object, so records are isolated and reads/writes are O(1).
 * Ids are namespaced (pk-) because the test pool shares storage across files.
 */
describe("per-participant keying", () => {
  function participantStub(participantId: string) {
    const edge = env as unknown as Env;
    return edge.PARTICIPANT_DO.get(edge.PARTICIPANT_DO.idFromName(participantObjectName(participantId)));
  }

  async function onboard(participantId: string, market: string, document = "12345678901"): Promise<Response> {
    return postCommand({
      type: "participant.onboarded",
      participantId,
      role: "buyer",
      displayName: participantId,
      idDocumentType: "bvn",
      idDocument: document,
      facialCaptureRef: "r2://archive/captures/face-pk.jpg",
      market,
    });
  }

  it("reads back the caller's own participant after onboarding", async () => {
    expect((await onboard("participant-pk-self", "PK Self")).status).toBe(200);

    const profile = await SELF.fetch(new Request(`${BASE}/participants/participant-pk-self`));
    expect(profile.status).toBe(200);
    const participant = (await readJson(profile)).participant as { id: string; kycStatus: string; markets: string[] };
    expect(participant.id).toBe("participant-pk-self");
    expect(participant.kycStatus).toBe("preverified");
    expect(participant.markets).toEqual(["PK Self"]);
  });

  it("isolates two participants: a join touches only the caller's own object", async () => {
    expect((await onboard("participant-pk-alpha", "PK Alpha")).status).toBe(200);
    expect((await onboard("participant-pk-beta", "PK Beta")).status).toBe(200);

    const join = await postCommand({
      type: "market.joined",
      market: "PK Beta",
      participantId: "participant-pk-alpha",
      role: "buyer",
    });
    expect(join.status).toBe(200);

    const alpha = (await readJson(await SELF.fetch(new Request(`${BASE}/participants/participant-pk-alpha`))))
      .participant as { markets: string[] };
    expect(alpha.markets).toEqual(["PK Alpha", "PK Beta"]);

    // Beta's own record is untouched by alpha's join.
    const beta = (await readJson(await SELF.fetch(new Request(`${BASE}/participants/participant-pk-beta`))))
      .participant as { markets: string[] };
    expect(beta.markets).toEqual(["PK Beta"]);

    // The two records live in distinct objects, each holding exactly one participant.
    const alphaOwn = await readJson(await participantStub("participant-pk-alpha").fetch(new Request("http://do/participant/participant-pk-alpha")));
    expect((alphaOwn.participant as { id: string }).id).toBe("participant-pk-alpha");
    const betaMiss = await participantStub("participant-pk-beta").fetch(new Request("http://do/participant/participant-pk-alpha"));
    expect(betaMiss.status).toBe(404);
  });

  it("joining an unknown participant 404s without creating a record", async () => {
    const join = await postCommand({
      type: "market.joined",
      market: "PK Ghost",
      participantId: "participant-pk-ghost",
      role: "buyer",
    });
    // The market side accepts the member; the participant side 404s silently.
    expect(join.status).toBe(200);
    const ghost = await SELF.fetch(new Request(`${BASE}/participants/participant-pk-ghost`));
    expect(ghost.status).toBe(404);
  });

  it("rejects malformed KYC input without creating a participant record", async () => {
    expect((await onboard("participant-pk-failed", "PK Failed", "12345")).status).toBe(400);
    const profile = await SELF.fetch(new Request(`${BASE}/participants/participant-pk-failed`));
    expect(profile.status).toBe(404);
  });

  it("reads pre-rekey participants from the legacy single-object registry", async () => {
    const edge = env as unknown as Env;
    const legacyStub = edge.PARTICIPANT_DO.get(edge.PARTICIPANT_DO.idFromName(LEGACY_REGISTRY_NAME));
    await runInDurableObject(legacyStub, async (_instance, state) => {
      await state.storage.put(STATE_KEY, {
        participants: [
          {
            id: "participant-pk-legacy",
            role: "buyer",
            displayName: "Pre-rekey Ada",
            kycStatus: "verified",
            idDocumentType: "nin",
            idDocumentHash: "ab".repeat(32),
            facialCaptureRef: "r2://archive/captures/face-legacy.jpg",
            markets: ["Balogun"],
            createdAt: Date.now(),
          },
        ],
      });
    });

    // Miss on the per-participant object, hit on the legacy read fallback.
    expect((await participantStub("participant-pk-legacy").fetch(new Request("http://do/participant/participant-pk-legacy"))).status).toBe(404);
    const profile = await SELF.fetch(new Request(`${BASE}/participants/participant-pk-legacy`));
    expect(profile.status).toBe(200);
    const participant = (await readJson(profile)).participant as { id: string; displayName: string };
    expect(participant.id).toBe("participant-pk-legacy");
    expect(participant.displayName).toBe("Pre-rekey Ada");
  });
});
