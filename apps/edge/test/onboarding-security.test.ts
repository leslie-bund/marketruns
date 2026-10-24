import { fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signSessionToken } from "@market-runs/domain";
import { createApp } from "../src/app/app.js";
import type { Env } from "../src/config/env.js";
import { devIdentityVerifier } from "../src/kyc/verifier.js";
import { canTransact } from "../src/registry/index.js";
import { bindings, readJson } from "./helpers.js";

const BASE = "http://edge";
const IDENTITY_ORIGIN = "http://localhost:8789";
const INTERNAL_TOKEN = "edge-onboarding-internal-test-token";
const SESSION_SECRET = "market-runs-dev-session-secret";

function withEnv(overrides: Record<string, string | undefined>): Env {
  return new Proxy(bindings, {
    get: (target, prop, receiver) =>
      typeof prop === "string" && prop in overrides ? overrides[prop] : Reflect.get(target, prop, receiver),
  }) as Env;
}

function command(participantId: string, role: "buyer" | "seller" | "runner" = "buyer") {
  return {
    type: "participant.onboarded",
    participantId,
    role,
    displayName: "First Run",
    email: "first@example.com",
    consentAt: Date.now(),
    consentVersion: "kyc-onboarding-v1",
    idDocumentType: "bvn",
    idDocument: "12345678901",
    market: "Balogun",
  };
}

function postCommand(body: unknown, env: Env = bindings, headers: Record<string, string> = {}): Promise<Response> {
  return createApp().fetch(new Request(`${BASE}/command`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), env);
}

function proofReply(expectedParticipantId: string, expectedRole: string) {
  let requestBody: Record<string, unknown> | undefined;
  let internalToken: unknown;
  fetchMock.get(IDENTITY_ORIGIN).intercept({ path: "/auth/enrollment-proof", method: "POST" }).reply(200, (opts) => {
    requestBody = JSON.parse(String(opts.body)) as Record<string, unknown>;
    internalToken = (opts.headers as Record<string, unknown>)["x-identity-internal"];
    expect(requestBody.participantId).toBe(expectedParticipantId);
    expect(requestBody.role).toBe(expectedRole);
    return {
      participantId: expectedParticipantId,
      enrollmentProof: "p".repeat(64),
      kycStatus: "preverified",
      displayName: "First Run",
      verifiedLegalName: null,
      expiresAt: Date.now() + 60_000,
    };
  });
  return { requestBody: () => requestBody, internalToken: () => internalToken };
}

describe("secure first-run onboarding", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterAll(() => fetchMock.deactivate());

  it("allows a new staging participant, preserves role, and returns an internal identity proof", async () => {
    const identity = proofReply("participant-first-run", "runner");
    const env = withEnv({ IDENTITY_INTERNAL_TOKEN: INTERNAL_TOKEN });
    const response = await postCommand(command("participant-first-run", "runner"), env);
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.enrollmentProof).toBe("p".repeat(64));
    const participant = body.participant as Record<string, unknown>;
    expect(participant.role).toBe("runner");
    expect(participant.kycStatus).toBe("preverified");
    expect(participant.email).toBe("first@example.com");
    expect(participant.facialCaptureRef).toBeUndefined();
    expect(identity.internalToken()).toBe(INTERNAL_TOKEN);
    expect(identity.requestBody()?.kycStatus).toBe("preverified");
  });

  it("rejects unauthenticated duplicate participant ids without issuing another proof", async () => {
    const response = await postCommand(command("participant-first-run", "buyer"));
    expect(response.status).toBe(409);
    expect((await readJson(response)).error).toBe("participant-exists");
  });

  it("requires contact, consent, and a well-formed document before creating a participant", async () => {
    const missing = command("participant-missing-consent") as Record<string, unknown>;
    delete missing.consentAt;
    expect((await postCommand(missing)).status).toBe(400);
    expect((await postCommand({ ...command("participant-bad-document"), idDocument: "12345" })).status).toBe(400);
  });

  it("does not let a Bearer session onboard another participant or change role", async () => {
    const at = Date.now();
    const token = await signSessionToken({
      tokenId: "session-onboarding-owner",
      participantId: "participant-session-owner",
      role: "seller",
      iat: at,
      exp: at + 60_000,
    }, SESSION_SECRET);
    const response = await postCommand(command("participant-other", "runner"), bindings, { authorization: `Bearer ${token}` });
    expect(response.status).toBe(403);
  });

  it("fails closed for production preverification and leaves real KYC pending", async () => {
    const verification = await devIdentityVerifier.verify({
      participantId: "participant-production",
      idDocumentType: "bvn",
      idDocument: "12345678901",
    }, false);
    expect(verification).toBe("pending");
    expect(canTransact("preverified", false)).toBe(false);
    expect(canTransact("verified", false)).toBe(true);
    expect(canTransact("preverified", true)).toBe(true);
  });
});
