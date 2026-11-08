import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/config/env.js";
import { participantObjectName } from "../src/do/participant-do.js";
import { internalPost } from "../src/do/transport.js";
import { bindings, readJson } from "./helpers.js";

const PARTICIPANT_ID = "buyer:document-hmac-deployed";

function participantStub() {
  return bindings.PARTICIPANT_DO.get(bindings.PARTICIPANT_DO.idFromName(participantObjectName(PARTICIPANT_ID)));
}

function onboardingRequest() {
  return internalPost("/onboard", {
    type: "participant.onboarded",
    participantId: PARTICIPANT_ID,
    role: "buyer",
    displayName: "Deployed Participant",
    email: "deployed@example.com",
    consentAt: Date.now(),
    consentVersion: "kyc-onboarding-v1",
    idDocumentType: "bvn",
    idDocument: "12345678901",
    market: "Balogun",
  });
}

describe("ParticipantDO document HMAC configuration", () => {
  it("fails closed without the deployed secret instead of using the development key", async () => {
    const response = await runInDurableObject(participantStub(), async (instance) => {
      (instance as unknown as { env: Env }).env = {
        ...bindings,
        ALLOW_HEADER_AUTH: "false",
        ID_DOCUMENT_HMAC_SECRET: undefined,
      };
      return instance.fetch(onboardingRequest());
    });

    expect(response.status).toBe(503);
    expect(await readJson(response)).toMatchObject({ error: "participant-document-auth-unconfigured" });
    const profile = await participantStub().fetch(new Request(`http://do/participant/${encodeURIComponent(PARTICIPANT_ID)}`));
    expect(profile.status).toBe(404);
  });

  it("uses the development key only in the explicit header-auth demo", async () => {
    const response = await runInDurableObject(participantStub(), async (instance) => {
      (instance as unknown as { env: Env }).env = {
        ...bindings,
        ALLOW_HEADER_AUTH: "true",
        ID_DOCUMENT_HMAC_SECRET: undefined,
      };
      return instance.fetch(onboardingRequest());
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ type: "participant.recorded" });
  });
});
