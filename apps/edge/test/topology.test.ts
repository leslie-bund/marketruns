import { describe, expect, it } from "vitest";
import { createApp } from "../src/app/app.js";
import type { Env } from "../src/config/env.js";
import { bindings, readJson } from "./helpers.js";

const URLS = {
  OPS_ARCHIVE_URL: "https://archive-staging.example.com",
  IDENTITY_URL: "https://identity-staging.example.com",
  PAYMENTS_URL: "https://payments-staging.example.com",
  NOTIFICATIONS_URL: "https://notifications-staging.example.com",
};

const AUTH_SECRETS = {
  PAYMENTS_INTERNAL_TOKEN: "topology-payments-internal-test-token",
  ARCHIVE_INTERNAL_TOKEN: "topology-archive-internal-test-token",
  NOTIFICATION_INTERNAL_TOKEN: "topology-notification-internal-test-token",
  ID_DOCUMENT_HMAC_SECRET: "topology-document-hmac-test-secret",
  IDENTITY_SESSION_SECRET: "topology-identity-session-test-secret",
  IDENTITY_INTERNAL_TOKEN: "topology-identity-internal-test-token",
  OPS_AUTH_SECRET: "topology-ops-auth-test-secret-at-least-32-chars",
};

describe("deployed edge topology", () => {
  it("fails fast when deployed service URLs are missing", async () => {
    const response = await createApp().fetch(new Request("http://edge/healthz"), {
      ...bindings, ...AUTH_SECRETS, EDGE_ENV: "staging",
    } as Env);
    expect(response.status).toBe(503);
    expect((await readJson(response)).error).toBe("edge-topology-unconfigured");
  });

  it.each(["staging", "production"])("requires payments service auth in %s", async (EDGE_ENV) => {
    const response = await createApp().fetch(new Request("http://edge/healthz"), {
      ...bindings, ...URLS, ...AUTH_SECRETS, EDGE_ENV, PAYMENTS_INTERNAL_TOKEN: undefined,
    } as Env);
    expect(response.status).toBe(503);
    const body = await readJson(response);
    expect(body.error).toBe("edge-topology-unconfigured");
    expect(body.message).toContain("PAYMENTS_INTERNAL_TOKEN is required");
  });

  it.each(Object.keys(AUTH_SECRETS))("requires %s in staging", async (secret) => {
    const response = await createApp().fetch(new Request("http://edge/healthz"), {
      ...bindings,
      ...URLS,
      ...AUTH_SECRETS,
      EDGE_ENV: "staging",
      [secret]: undefined,
    } as Env);
    expect(response.status).toBe(503);
    const body = await readJson(response);
    expect(body.error).toBe("edge-topology-unconfigured");
    expect(body.message).toContain(`${secret} is required`);
  });

  it("rejects inherited loopback URLs and accepts an explicit HTTPS topology", async () => {
    const app = createApp();
    const loopback = await app.fetch(new Request("http://edge/healthz"), {
      ...bindings, ...URLS, ...AUTH_SECRETS, EDGE_ENV: "production", IDENTITY_URL: "http://localhost:8789",
    } as Env);
    expect(loopback.status).toBe(503);

    const valid = await app.fetch(new Request("http://edge/healthz"), {
      ...bindings, ...URLS, ...AUTH_SECRETS, EDGE_ENV: "production",
    } as Env);
    expect(valid.status).toBe(200);
  });

  it("keeps local development defaults working", async () => {
    const response = await createApp().fetch(new Request("http://edge/healthz"), bindings);
    expect(response.status).toBe(200);
  });
});
