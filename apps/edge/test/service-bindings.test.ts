import { describe, expect, it } from "vitest";
import { createApp } from "../src/app/app.js";
import type { Env } from "../src/config/env.js";
import { bindings } from "./helpers.js";

function withEnv(overrides: Record<string, unknown>): Env {
  return new Proxy(bindings, {
    get: (target, prop, receiver) =>
      typeof prop === "string" && prop in overrides ? overrides[prop] : Reflect.get(target, prop, receiver),
  }) as Env;
}

describe("deployed Worker service bindings", () => {
  it("uses the payments binding while preserving path and internal authentication", async () => {
    let seenUrl = "";
    let seenToken: string | null = null;
    const service = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        seenUrl = String(input);
        seenToken = new Headers(init?.headers).get("x-payments-internal");
        return Response.json({ items: [] });
      },
    } as unknown as Fetcher;
    const env = withEnv({ PAYMENTS_SERVICE: service, PAYMENTS_INTERNAL_TOKEN: "test-service-token" });
    const response = await createApp().fetch(new Request("http://edge/payments/banks"), env);
    expect(response.status).toBe(200);
    expect(seenUrl).toBe(`${env.PAYMENTS_URL}/payments/banks`);
    expect(seenToken).toBe(env.PAYMENTS_INTERNAL_TOKEN);
  });

  it("uses the identity binding for onboarding proof issuance", async () => {
    const participantId = `binding-onboard-${Date.now()}`;
    let seenUrl = "";
    const service = {
      fetch: async (input: RequestInfo | URL) => {
        seenUrl = String(input);
        return Response.json({
          participantId, enrollmentProof: "p".repeat(64), kycStatus: "preverified",
          displayName: "Binding Test", verifiedLegalName: null, expiresAt: Date.now() + 60_000,
        });
      },
    } as unknown as Fetcher;
    const env = withEnv({ IDENTITY_SERVICE: service, IDENTITY_INTERNAL_TOKEN: "test-service-token", ID_DOCUMENT_HMAC_SECRET: "test-document-secret" });
    const response = await createApp().fetch(new Request("http://edge/command", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        type: "participant.onboarded", participantId, role: "buyer", displayName: "Binding Test",
        email: "binding@example.com", consentAt: Date.now(), consentVersion: "kyc-onboarding-v1",
        idDocumentType: "bvn", idDocument: "12345678901", market: "Balogun",
      }),
    }), env);
    expect(response.status).toBe(200);
    expect((await response.json()).enrollmentProof).toBe("p".repeat(64));
    expect(seenUrl).toBe(`${env.IDENTITY_URL}/auth/enrollment-proof`);
  });

  it("uses the identity binding for provider callbacks", async () => {
    let seenUrl = "";
    const service = {
      fetch: async (input: RequestInfo | URL) => {
        seenUrl = String(input);
        return Response.json({ error: "callback-invalid", message: "invalid callback signature" }, { status: 401 });
      },
    } as unknown as Fetcher;
    const env = withEnv({ IDENTITY_SERVICE: service });
    const response = await createApp().fetch(new Request("http://edge/callbacks/smileid", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }), env);
    expect(response.status).toBe(401);
    expect(seenUrl).toBe(`${env.IDENTITY_URL}/callbacks/smileid`);
  });

  it("uses the archive binding for ops admin reads with path, query, and authentication intact", async () => {
    let seenUrl = "";
    let seenToken: string | null = null;
    const service = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        seenUrl = String(input);
        seenToken = new Headers(init?.headers).get("x-archive-internal");
        return Response.json({ items: [], total: 0, limit: 40, offset: 0 });
      },
    } as unknown as Fetcher;
    const env = withEnv({ ARCHIVE_SERVICE: service, ARCHIVE_INTERNAL_TOKEN: "test-archive-token" });
    const response = await createApp().fetch(new Request("http://edge/ops/api/admin/runs?kind=live&limit=40&offset=0"), env);
    expect(response.status).toBe(200);
    expect(seenUrl).toBe(`${env.OPS_ARCHIVE_URL}/admin/runs?kind=live&limit=40&offset=0`);
    expect(seenToken).toBe("test-archive-token");
  });

  it("uses the payments binding for ops dispatch reads", async () => {
    let seenUrl = "";
    let seenToken: string | null = null;
    const service = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        seenUrl = String(input);
        seenToken = new Headers(init?.headers).get("x-payments-internal");
        return Response.json({ items: [], total: 0, limit: 40, offset: 0 });
      },
    } as unknown as Fetcher;
    const env = withEnv({ PAYMENTS_SERVICE: service, PAYMENTS_INTERNAL_TOKEN: "test-payments-token" });
    const response = await createApp().fetch(new Request("http://edge/ops/api/admin/payments?limit=40&offset=0"), env);
    expect(response.status).toBe(200);
    expect(seenUrl).toBe(`${env.PAYMENTS_URL}/dispatches?limit=40&offset=0`);
    expect(seenToken).toBe("test-payments-token");
  });

  it("uses the payments binding for ops recovery actions", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const service = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        seenUrl = String(input);
        seenMethod = init?.method ?? "GET";
        return Response.json({ status: "queued" });
      },
    } as unknown as Fetcher;
    const env = withEnv({ PAYMENTS_SERVICE: service, PAYMENTS_INTERNAL_TOKEN: "test-payments-token" });
    const response = await createApp().fetch(new Request("http://edge/ops/api/admin/payments/dispatch-1/replay", { method: "POST" }), env);
    expect(response.status).toBe(200);
    expect(seenUrl).toBe(`${env.PAYMENTS_URL}/dispatches/dispatch-1/replay`);
    expect(seenMethod).toBe("POST");
  });

  it("uses the identity binding for the ops device-reset queue", async () => {
    let seenUrl = "";
    let seenToken: string | null = null;
    const service = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        seenUrl = String(input);
        seenToken = new Headers(init?.headers).get("x-identity-internal");
        return Response.json({ requests: [] });
      },
    } as unknown as Fetcher;
    const env = withEnv({ IDENTITY_SERVICE: service, IDENTITY_INTERNAL_TOKEN: "test-identity-token" });
    const response = await createApp().fetch(new Request("http://edge/ops/api/device-resets?status=pending"), env);
    expect(response.status).toBe(200);
    expect(seenUrl).toBe(`${env.IDENTITY_URL}/auth/device-reset?status=pending`);
    expect(seenToken).toBe("test-identity-token");
  });
});
