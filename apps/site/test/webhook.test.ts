import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import { createSiteDatabase, insertInboundEmail, listEmailReplies, listInboundEmails, listLeadRegistrations } from "../src/db";
import { isAdminEmail, type SiteEnv } from "../src/env";
import { registerLead } from "../src/registrations";
import { sendInboundReply } from "../src/replies";
import { handleResendWebhook } from "../src/webhooks/resend";

const mocks = vi.hoisted(() => ({ send: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
    contacts = { get: mocks.get, create: mocks.create, update: mocks.update };
  },
}));

const secret = "whsec_" + Buffer.from("test-secret-test-secret-test").toString("base64");

function testEnv(overrides: Partial<SiteEnv> = {}): SiteEnv {
  return {
    port: 0,
    host: "127.0.0.1",
    baseUrl: "https://www.marketruns.org",
    authSecret: "test-auth-secret-test-auth-secret-32",
    databaseUrl: undefined,
    databasePath: ":memory:",
    nodeEnv: "test",
    resendApiKey: undefined,
    resendAudienceId: undefined,
    resendWebhookSecret: secret,
    resendFromEmail: "Market Runs <hello@marketruns.org>",
    inboundEmail: "hello@marketruns.org",
    adminEmails: ["admin@marketruns.org"],
    ...overrides,
  };
}

const event = {
  type: "email.received",
  created_at: "2026-10-31T12:00:00.000Z",
  data: {
    email_id: "em_test_123",
    from: "smileid@example.com",
    to: ["hello@marketruns.org"],
    subject: "Your Smile ID verification",
    message_id: "original@example.com",
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

beforeEach(() => {
  mocks.send.mockReset().mockResolvedValue({ data: { id: "email_123" }, error: null });
  mocks.get.mockReset().mockResolvedValue({ data: null, error: { statusCode: 404, name: "not_found_error" } });
  mocks.create.mockReset().mockResolvedValue({ data: { id: "contact_123" }, error: null });
  mocks.update.mockReset().mockResolvedValue({ data: { id: "contact_123" }, error: null });
});

afterEach(() => vi.clearAllMocks());

describe("Resend webhook", () => {
  it("answers 503 until RESEND_WEBHOOK_SECRET is configured", async () => {
    const env = testEnv({ resendWebhookSecret: undefined });
    const site = await createSiteDatabase(env);
    const result = await handleResendWebhook(JSON.stringify(event), {}, env, site);
    expect(result.status).toBe(503);
  });

  it("rejects an invalid signature with 401", async () => {
    const env = testEnv();
    const site = await createSiteDatabase(env);
    const result = await handleResendWebhook(JSON.stringify(event), {
      "svix-id": "msg_x", "svix-timestamp": "1", "svix-signature": "v1,bogus",
    }, env, site);
    expect(result.status).toBe(401);
  });

  it("verifies the signature and stores the received email", async () => {
    const env = testEnv();
    const site = await createSiteDatabase(env);
    const body = JSON.stringify(event);
    const result = await handleResendWebhook(body, signedHeaders(body), env, site);
    expect(result.status).toBe(200);
    const stored = await listInboundEmails(site);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.resend_email_id).toBe("em_test_123");
    expect(stored[0]?.from_address).toBe("smileid@example.com");
  });

  it("ignores non-received event types without storing", async () => {
    const env = testEnv();
    const site = await createSiteDatabase(env);
    const body = JSON.stringify({ ...event, type: "email.delivered" });
    const result = await handleResendWebhook(body, signedHeaders(body), env, site);
    expect(result.status).toBe(200);
    expect(await listInboundEmails(site)).toHaveLength(0);
  });
});

describe("visitor registrations", () => {
  it("stores the lead and sends an idempotent confirmation", async () => {
    const env = testEnv({ resendApiKey: "re_test" });
    const site = await createSiteDatabase(env);
    const result = await registerLead(env, site, { name: "Ada Lovelace", email: "ada@example.com", consent: true, interest: "buyer", message: "Balogun" });
    expect(result.status).toBe(201);
    expect(result.body.confirmationSent).toBe(true);
    const leads = await listLeadRegistrations(site);
    expect(leads).toHaveLength(1);
    expect(leads[0]?.confirmation_sent).toBe("sent");
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls[0]?.[1]).toEqual({ idempotencyKey: `lead-confirmation/${leads[0]?.id}` });
    expect(mocks.send.mock.calls[0]?.[0].html).toContain("Ada Lovelace");
    expect(mocks.send.mock.calls[0]?.[0].text).toContain("Market Runs");
  });

  it("keeps the lead when email is not configured", async () => {
    const env = testEnv();
    const site = await createSiteDatabase(env);
    const result = await registerLead(env, site, { name: "Ada Lovelace", email: "ada@example.com", consent: true, interest: "seller", message: "" });
    expect(result.status).toBe(201);
    expect(result.body.confirmationSent).toBe(false);
    expect((await listLeadRegistrations(site))[0]?.confirmation_sent).toBe("failed");
  });
});

describe("admin replies", () => {
  async function siteWithInbound(env: SiteEnv) {
    const site = await createSiteDatabase(env);
    await insertInboundEmail(site, {
      id: "6f796d1c-2f7f-4f4f-b6df-2e8fbe4df3bb",
      event_type: "email.received",
      resend_email_id: "em_test_123",
      from_address: "smileid@example.com",
      to_addresses: JSON.stringify(["hello@marketruns.org"]),
      subject: "Application update",
      text_body: "Tell us more",
      html_body: null,
      raw_payload: JSON.stringify(event),
      received_at: event.created_at,
    });
    return site;
  }

  it("sanitizes rich HTML, threads the reply, and records it", async () => {
    const env = testEnv({ resendApiKey: "re_test" });
    const site = await siteWithInbound(env);
    const result = await sendInboundReply(env, site, {
      inboundEmailId: "6f796d1c-2f7f-4f4f-b6df-2e8fbe4df3bb",
      html: "<p>Hello <strong>Smile ID</strong></p><script>alert(1)</script>",
      text: "Hello Smile ID",
    });
    expect(result.status).toBe(200);
    const replies = await listEmailReplies(site, "6f796d1c-2f7f-4f4f-b6df-2e8fbe4df3bb");
    expect(replies[0]?.html_body).toBe("<p>Hello <strong>Smile ID</strong></p>");
    expect(replies[0]?.status).toBe("sent");
    expect(mocks.send.mock.calls[0]?.[0].headers).toEqual({ "In-Reply-To": "<original@example.com>", References: "<original@example.com>" });
  });

  it("records a failed reply without pretending it was sent", async () => {
    const env = testEnv();
    const site = await siteWithInbound(env);
    const result = await sendInboundReply(env, site, {
      inboundEmailId: "6f796d1c-2f7f-4f4f-b6df-2e8fbe4df3bb",
      html: "<p>Hello</p>",
      text: "Hello",
    });
    expect(result.status).toBe(502);
    expect((await listEmailReplies(site, "6f796d1c-2f7f-4f4f-b6df-2e8fbe4df3bb"))[0]?.status).toBe("failed");
  });
});

describe("admin gating", () => {
  it("recognises admin emails case-insensitively", () => {
    const env = testEnv();
    expect(isAdminEmail(env, "admin@marketruns.org")).toBe(true);
    expect(isAdminEmail(env, " Admin@MarketRuns.org ")).toBe(true);
    expect(isAdminEmail(env, "buyer@example.com")).toBe(false);
  });
});
