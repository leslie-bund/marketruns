import { describe, expect, it } from "vitest";
import { signSessionToken } from "@market-runs/domain";
import { CONSUMER_POLICY_VERSION } from "@market-runs/proto";
import { createApp } from "../src/app/app.js";
import type { Env } from "../src/config/env.js";
import { coreRegistry } from "../src/registry/index.js";
import { bindings, readJson } from "./helpers.js";

const PARTICIPANT_ID = "participant-policy-acceptance";
const SESSION_SECRET = "market-runs-dev-session-secret";
const testEnv = { ...bindings, IDENTITY_SESSION_SECRET: SESSION_SECRET } as Env;

async function session(participantId = PARTICIPANT_ID): Promise<string> {
  const at = Date.now();
  return signSessionToken({
    tokenId: `session-${participantId}`,
    participantId,
    role: "buyer",
    iat: at,
    exp: at + 60_000,
  }, SESSION_SECRET);
}

async function accept(token: string, policyVersion: string, participantId = PARTICIPANT_ID): Promise<Response> {
  return createApp().fetch(new Request(`http://edge/participants/${participantId}/consumer-policy-acceptance`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ policyVersion }),
  }), testEnv);
}

async function joinMarket(token: string): Promise<Response> {
  return createApp().fetch(new Request("http://edge/command", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: "market.joined", market: "Balogun", participantId: PARTICIPANT_ID, role: "buyer" }),
  }), testEnv);
}

describe("consumer policy acknowledgement", () => {
  it("requires the current version, restricts acceptance to the caller, and preserves the first timestamp", async () => {
    await coreRegistry(testEnv).saveParticipant({
      id: PARTICIPANT_ID,
      role: "buyer",
      displayName: "Policy Buyer",
      email: "policy@example.com",
      kycStatus: "verified",
      idDocumentType: "bvn",
      idDocumentHash: "ab".repeat(32),
      markets: ["Balogun"],
      createdAt: Date.now(),
    });
    const token = await session();

    const blocked = await joinMarket(token);
    expect(blocked.status).toBe(403);
    expect((await readJson(blocked)).error).toBe("consumer-policy-acceptance-required");

    expect((await accept(token, "consumer-refund-v0")).status).toBe(409);
    expect((await accept(token, CONSUMER_POLICY_VERSION, "participant-policy-other")).status).toBe(403);
    expect((await createApp().fetch(new Request(`http://edge/participants/${PARTICIPANT_ID}/consumer-policy-acceptance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policyVersion: CONSUMER_POLICY_VERSION }),
    }), testEnv)).status).toBe(401);

    const first = await accept(token, CONSUMER_POLICY_VERSION);
    expect(first.status).toBe(200);
    const firstBody = await readJson(first);
    const acceptance = firstBody.acceptance as { acceptedAt: number; policyVersion: string };
    expect(acceptance.policyVersion).toBe(CONSUMER_POLICY_VERSION);
    expect(acceptance.acceptedAt).toBeGreaterThan(0);
    expect((firstBody.participant as { consumerPolicyVersion: string }).consumerPolicyVersion).toBe(CONSUMER_POLICY_VERSION);

    const repeated = await accept(token, CONSUMER_POLICY_VERSION);
    expect(repeated.status).toBe(200);
    expect(((await readJson(repeated)).acceptance as { acceptedAt: number }).acceptedAt).toBe(acceptance.acceptedAt);
    expect((await joinMarket(token)).status).toBe(200);
  });
});
