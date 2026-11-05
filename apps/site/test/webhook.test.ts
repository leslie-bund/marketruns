import { describe, expect, it } from "vitest";
import { Webhook } from "svix";
import { buildApp } from "../src/app.js";
import { migrateAuth } from "../src/auth.js";
import { createSiteDatabase, listInboundEmails } from "../src/db.js";
import { isAdminEmail, type SiteEnv } from "../src/env.js";

const secret = "whsec_" + Buffer.from("test-secret-test-secret-test").toString("base64");

function testEnv(overrides: Partial<SiteEnv> = {}): SiteEnv {
  return {
    port: 0,
    host: "127.0.0.1",
    baseUrl: "http://localhost:8795",
    authSecret: "test-auth-secret-test-auth-secret-32",
    databaseUrl: undefined,
    databasePath: ":memory:",
    nodeEnv: "test",
    resendApiKey: undefined,
    resendWebhookSecret: secret,
    resendFromEmail: undefined,
    inboundEmail: "hello@market-runs.example",
    adminEmails: ["admin@market-runs.example"],
    ...overrides,
  };
}

const event = {
  type: "email.received",
  created_at: "2026-10-31T12:00:00.000Z",
  data: {
    email_id: "em_test_123",
    from: "smileid@example.com",
    to: ["hello@market-runs.example"],
    subject: "Your Smile ID verification",
    created_at: "2026-10-31T12:00:00.000Z",
  },
};

function signedHeaders(body: string): Record<string, string> {
  const wh = new Webhook(secret);
  const msgId = "msg_test_1";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return {
    "svix-id": msgId,
    "svix-timestamp": timestamp,
    "svix-signature": wh.sign(msgId, new Date(Number(timestamp) * 1000), body),
    "content-type": "application/json",
  };
}

async function makeApp(envOverrides: Partial<SiteEnv> = {}) {
  const env = testEnv(envOverrides);
  const site = await createSiteDatabase(env);
  const { app, auth } = buildApp(env, site);
  await migrateAuth(auth);
  return { app, site };
}

describe("POST /api/webhooks/resend", () => {
  it("answers 503 until RESEND_WEBHOOK_SECRET is configured", async () => {
    const { app } = await makeApp({ resendWebhookSecret: undefined });
    const res = await app.request("/api/webhooks/resend", { method: "POST", body: JSON.stringify(event) });
    expect(res.status).toBe(503);
  });

  it("rejects an invalid signature with 401", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/webhooks/resend", {
      method: "POST",
      headers: { "svix-id": "msg_x", "svix-timestamp": "1", "svix-signature": "v1,bogus" },
      body: JSON.stringify(event),
    });
    expect(res.status).toBe(401);
  });

  it("verifies the svix signature and stores the received email", async () => {
    const { app, site } = await makeApp();
    const body = JSON.stringify(event);
    const res = await app.request("/api/webhooks/resend", { method: "POST", headers: signedHeaders(body), body });
    expect(res.status).toBe(200);
    const stored = await listInboundEmails(site);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.resend_email_id).toBe("em_test_123");
    expect(stored[0]?.from_address).toBe("smileid@example.com");
    expect(stored[0]?.subject).toBe("Your Smile ID verification");
  });

  it("ignores non-received event types without storing", async () => {
    const { app, site } = await makeApp();
    const body = JSON.stringify({ ...event, type: "email.delivered" });
    const res = await app.request("/api/webhooks/resend", { method: "POST", headers: signedHeaders(body), body });
    expect(res.status).toBe(200);
    expect(await listInboundEmails(site)).toHaveLength(0);
  });
});

describe("admin gating", () => {
  it("recognises admin emails case-insensitively", () => {
    const env = testEnv();
    expect(isAdminEmail(env, "admin@market-runs.example")).toBe(true);
    expect(isAdminEmail(env, " Admin@Market-Runs.example ")).toBe(true);
    expect(isAdminEmail(env, "buyer@example.com")).toBe(false);
  });

  it("redirects anonymous visitors away from the inbox", async () => {
    const { app } = await makeApp();
    const res = await app.request("/inbox");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/sign-in");
  });
});
