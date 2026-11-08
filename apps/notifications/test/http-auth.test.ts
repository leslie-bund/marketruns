import { describe, expect, it } from "vitest";
import worker, { createNotificationsApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { MemoryNotificationStore } from "../src/memory-store.js";
import type { NotificationProviders } from "../src/provider.js";

const providers: NotificationProviders = {
  websocket: async () => ({ kind: "skipped", error: "test" }),
  email: async () => ({ kind: "skipped", error: "test" }),
};

describe("notifications internal HTTP authentication", () => {
  it("fails closed when explicit app options have neither a token nor the header-auth demo", async () => {
    const app = createNotificationsApp(new MemoryNotificationStore(), providers, {});

    const response = await app.fetch(new Request("http://notifications/notifications", {
      headers: { "x-participant-id": "buyer:1" },
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "notification-auth-unconfigured" });

    const health = await app.fetch(new Request("http://notifications/healthz"));
    expect(health.status).toBe(200);
  });

  it("rejects wrong or missing credentials when a token is configured", async () => {
    const app = createNotificationsApp(new MemoryNotificationStore(), providers, { internalToken: "expected-token" });
    for (const headers of [{}, { "x-notification-internal": "forged-token" }]) {
      const response = await app.fetch(new Request("http://notifications/notifications", {
        headers: { ...headers, "x-participant-id": "buyer:1" },
      }));
      expect(response.status).toBe(401);
    }
  });

  it("allows tokenless reads only without options or in the explicit header-auth demo", async () => {
    for (const app of [
      createNotificationsApp(new MemoryNotificationStore(), providers),
      createNotificationsApp(new MemoryNotificationStore(), providers, { allowHeaderAuth: true }),
    ]) {
      const response = await app.fetch(new Request("http://notifications/notifications", {
        headers: { "x-participant-id": "buyer:1" },
      }));
      expect(response.status).toBe(200);
    }
  });

  it("returns 503 for staging validation failures at the worker boundary", async () => {
    const response = await worker.fetch(new Request("http://notifications/healthz"), {
      NOTIFICATIONS_ENV: "staging",
      EDGE_URL: "https://edge-staging.example.com",
    } as Env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "notification-topology-unconfigured",
      message: "NOTIFICATION_INTERNAL_TOKEN is required when NOTIFICATIONS_ENV=staging",
    });
  });
});
