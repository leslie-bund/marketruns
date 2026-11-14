import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";

const INTERNAL_TOKEN = "archive-internal-test-token";

function env(overrides: Partial<Env> = {}): Env {
  return {
    PAYMENT_QUEUE: { sendBatch: async () => undefined },
    ...overrides,
  } as unknown as Env;
}

describe("archive internal read authentication", () => {
  it("requires the configured token on reputation and every admin route while health stays public", async () => {
    const configured = env({ ARCHIVE_INTERNAL_TOKEN: INTERNAL_TOKEN });
    const protectedPaths = [
      "/reputation?participant=buyer:1&role=buyer",
      "/admin/runs",
      "/admin/disputes",
      "/admin/settlements",
      "/admin/ledger",
      "/admin/ops-health?market=Balogun",
      "/admin/retained-media",
      "/admin/future-read",
    ];

    for (const path of protectedPaths) {
      const missing = await worker.fetch(new Request(`http://archive${path}`), configured);
      expect(missing.status, `missing token: ${path}`).toBe(401);
      const wrong = await worker.fetch(new Request(`http://archive${path}`, {
        headers: { "x-archive-internal": "forged-token" },
      }), configured);
      expect(wrong.status, `wrong token: ${path}`).toBe(401);
    }

    const health = await worker.fetch(new Request("http://archive/healthz"), configured);
    expect(health.status).toBe(200);
    const authorized = await worker.fetch(new Request("http://archive/admin/future-read", {
      headers: { "x-archive-internal": INTERNAL_TOKEN },
    }), configured);
    expect(authorized.status).toBe(404);
  });

  it("fails closed without a token except in the explicit header-auth demo", async () => {
    const response = await worker.fetch(new Request("http://archive/admin/runs"), env());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "archive-auth-unconfigured" });

    const demo = await worker.fetch(
      new Request("http://archive/admin/future-read"),
      env({ ALLOW_HEADER_AUTH: "true" }),
    );
    expect(demo.status).toBe(404);
  });

  it("guards protected paths before method routing", async () => {
    const configured = await worker.fetch(
      new Request("http://archive/admin/runs", { method: "POST" }),
      env({ ARCHIVE_INTERNAL_TOKEN: INTERNAL_TOKEN }),
    );
    expect(configured.status).toBe(401);

    const unconfigured = await worker.fetch(
      new Request("http://archive/reputation", { method: "POST" }),
      env(),
    );
    expect(unconfigured.status).toBe(503);
  });

  it("validates the staging secret before serving any route", async () => {
    const response = await worker.fetch(
      new Request("http://archive/healthz"),
      env({ ARCHIVE_ENV: "staging" } as Partial<Env>),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "archive-topology-unconfigured",
      message: "ARCHIVE_INTERNAL_TOKEN is required when ARCHIVE_ENV=staging",
    });
  });
});
