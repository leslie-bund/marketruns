import { env, runInDurableObject } from "cloudflare:test";
import { signSessionToken } from "@market-runs/domain";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app/app.js";
import type { Env } from "../src/config/env.js";
import { participantObjectName } from "../src/do/participant-do.js";
import { coreRegistry } from "../src/registry/index.js";

const bindings = env as unknown as Env;
const SESSION_SECRET = "notification-test-session-secret";
const INTERNAL_TOKEN = "notification-test-internal-token";

function productionEnv(secret: string | undefined = SESSION_SECRET): Env {
  return { ...bindings, ALLOW_HEADER_AUTH: "false", IDENTITY_SESSION_SECRET: secret };
}

async function sessionToken(participantId: string, secret = SESSION_SECRET): Promise<string> {
  const now = Date.now();
  return signSessionToken({ tokenId: `token:${participantId}`, participantId, role: "buyer", iat: now, exp: now + 60_000 }, secret);
}

async function socketAttachments(participantId: string): Promise<Array<Record<string, unknown>>> {
  const stub = bindings.PARTICIPANT_DO.get(bindings.PARTICIPANT_DO.idFromName(participantObjectName(participantId)));
  return runInDurableObject(stub, async (_instance, state) =>
    state.getWebSockets().map((socket) => socket.deserializeAttachment() as Record<string, unknown>));
}

describe("notification WebSocket authentication", () => {
  it("routes a production query-token socket only to the token participant's object", async () => {
    const participantId = "buyer:notification-ws-token";
    const token = await sessionToken(participantId);
    const response = await createApp().fetch(new Request(`http://edge/notifications/live?access_token=${encodeURIComponent(token)}`, {
      headers: { upgrade: "websocket" },
    }), productionEnv());

    expect(response.status).toBe(101);
    expect(await socketAttachments(participantId)).toHaveLength(1);
    expect((await socketAttachments(participantId))[0]?.participantId).toBe(participantId);
    expect(await socketAttachments("buyer:other-notification-recipient")).toHaveLength(0);
    expect(await socketAttachments("unauthenticated")).toHaveLength(0);
    response.webSocket?.accept();
    response.webSocket?.close();
  });

  it("fails closed for invalid tokens and when the production session secret is absent", async () => {
    const wrongSecretToken = await sessionToken("buyer:wrong-secret", "not-the-configured-secret");
    const invalid = await createApp().fetch(new Request(`http://edge/notifications/live?access_token=${encodeURIComponent(wrongSecretToken)}`, {
      headers: { upgrade: "websocket" },
    }), productionEnv());
    expect(invalid.status).toBe(401);

    const developmentToken = await sessionToken("buyer:no-production-secret", "market-runs-dev-session-secret");
    const noSecret = await createApp().fetch(new Request(`http://edge/notifications/live?access_token=${encodeURIComponent(developmentToken)}`, {
      headers: { upgrade: "websocket" },
    }), productionEnv(undefined));
    expect(noSecret.status).toBe(401);
  });

  it("never accepts access_token on ordinary HTTP requests", async () => {
    const token = await sessionToken("buyer:http-query-token");
    const liveWithoutUpgrade = await createApp().fetch(
      new Request(`http://edge/notifications/live?access_token=${encodeURIComponent(token)}`),
      productionEnv(),
    );
    expect(liveWithoutUpgrade.status).toBe(401);

    const durableList = await createApp().fetch(
      new Request(`http://edge/notifications?access_token=${encodeURIComponent(token)}`),
      productionEnv(),
    );
    expect(durableList.status).toBe(401);
  });
});

describe("internal notification contact lookup", () => {
  function contactEnv(): Env {
    return { ...bindings, ALLOW_HEADER_AUTH: "true", NOTIFICATION_INTERNAL_TOKEN: INTERNAL_TOKEN };
  }

  async function saveParticipant(participantId: string, email?: string): Promise<void> {
    await coreRegistry(contactEnv()).saveParticipant({
      id: participantId,
      role: "buyer",
      displayName: "Notification Recipient",
      ...(email ? { email } : {}),
      verifiedLegalName: "Private Legal Name",
      kycStatus: "verified",
      idDocumentType: "bvn",
      idDocumentHash: "private-document-hash",
      markets: ["Balogun"],
      createdAt: Date.now(),
    });
  }

  function contactRequest(participantId: string, token = INTERNAL_TOKEN): Request {
    return new Request(`http://edge/internal/notification-contact/${encodeURIComponent(participantId)}`, {
      headers: { "x-notification-internal": token },
    });
  }

  it("returns only the registry email to the authenticated notifications worker", async () => {
    const participantId = "buyer:notification-contact-success";
    await saveParticipant(participantId, "receipts@example.com");
    const response = await createApp().fetch(contactRequest(participantId), contactEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: "receipts@example.com" });
  });

  it("returns 404 for unknown participants and profiles without an email", async () => {
    const withoutEmail = "buyer:notification-contact-no-email";
    await saveParticipant(withoutEmail);
    for (const participantId of ["buyer:notification-contact-unknown", withoutEmail]) {
      const response = await createApp().fetch(contactRequest(participantId), contactEnv());
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: "contact-not-found" });
    }
  });

  it("rejects unauthorized contact reads without exposing participant data", async () => {
    const participantId = "buyer:notification-contact-unauthorized";
    await saveParticipant(participantId, "private@example.com");
    for (const token of ["wrong-token", ""]) {
      const response = await createApp().fetch(contactRequest(participantId, token), contactEnv());
      expect(response.status).toBe(401);
      expect(JSON.stringify(await response.json())).not.toContain("private@example.com");
    }
    const noProductionSecret = await createApp().fetch(contactRequest(participantId), {
      ...contactEnv(),
      ALLOW_HEADER_AUTH: "false",
      NOTIFICATION_INTERNAL_TOKEN: undefined,
    });
    expect(noProductionSecret.status).toBe(401);
  });
});
