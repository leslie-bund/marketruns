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

describe("deployed edge topology", () => {
  it("fails fast when deployed service URLs are missing", async () => {
    const response = await createApp().fetch(new Request("http://edge/healthz"), { ...bindings, EDGE_ENV: "staging" } as Env);
    expect(response.status).toBe(503);
    expect((await readJson(response)).error).toBe("edge-topology-unconfigured");
  });

  it("rejects inherited loopback URLs and accepts an explicit HTTPS topology", async () => {
    const app = createApp();
    const loopback = await app.fetch(new Request("http://edge/healthz"), {
      ...bindings, ...URLS, EDGE_ENV: "production", IDENTITY_URL: "http://localhost:8789",
    } as Env);
    expect(loopback.status).toBe(503);

    const valid = await app.fetch(new Request("http://edge/healthz"), { ...bindings, ...URLS, EDGE_ENV: "production" } as Env);
    expect(valid.status).toBe(200);
  });

  it("keeps local development defaults working", async () => {
    const response = await createApp().fetch(new Request("http://edge/healthz"), bindings);
    expect(response.status).toBe(200);
  });
});
