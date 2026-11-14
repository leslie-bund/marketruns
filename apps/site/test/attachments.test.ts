import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/admin/inbox/[id]/attachments/[attachmentId]/route";
import { POST as postReply } from "../app/api/admin/replies/route";
import { getInboundAttachmentUrl, listInboundAttachments } from "../src/attachments";
import { createSiteDatabase, insertInboundEmail, listEmailReplies } from "../src/db";
import type { SiteEnv } from "../src/env";
import { replyAttachmentError } from "../src/reply-attachments";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  getAttachment: vi.fn(),
  send: vi.fn(),
  session: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: mocks.send,
      receiving: { attachments: { list: mocks.list, get: mocks.getAttachment } },
    };
  },
}));

vi.mock("../src/server", () => ({ getSessionContext: mocks.session }));

const inboundId = "6f796d1c-2f7f-4f4f-b6df-2e8fbe4df3bb";
const attachmentId = "2a0c9ce0-3112-4728-976e-47ddcd16a318";
const downloadUrl = "https://inbound-cdn.resend.com/em_test_123/attachments/2a0c9ce0-3112-4728-976e-47ddcd16a318?signature=sig-123";
const attachment = {
  id: attachmentId,
  filename: "verification.pdf",
  size: 4096,
  content_type: "application/pdf",
  content_disposition: "attachment",
  download_url: downloadUrl,
  expires_at: "2026-11-14T14:00:00.000Z",
};

function testEnv(overrides: Partial<SiteEnv> = {}): SiteEnv {
  return {
    port: 0,
    host: "127.0.0.1",
    baseUrl: "https://www.marketruns.org",
    authSecret: "test-auth-secret-test-auth-secret-32",
    databaseUrl: undefined,
    databasePath: ":memory:",
    nodeEnv: "test",
    resendApiKey: "re_test",
    resendAudienceId: undefined,
    resendWebhookSecret: undefined,
    resendFromEmail: "Market Runs <hello@marketruns.org>",
    inboundEmail: "hello@marketruns.org",
    adminEmails: ["admin@marketruns.org"],
    ...overrides,
  };
}

async function siteWithInbound(env: SiteEnv) {
  const site = await createSiteDatabase(env);
  await insertInboundEmail(site, {
    id: inboundId,
    event_type: "email.received",
    resend_email_id: "em_test_123",
    from_address: "smileid@example.com",
    to_addresses: JSON.stringify(["hello@marketruns.org"]),
    subject: "Application update",
    text_body: "See attached",
    html_body: null,
    raw_payload: "{}",
    received_at: "2026-11-14T12:00:00.000Z",
  });
  return site;
}

function downloadRequest(id = inboundId, idForAttachment = attachmentId) {
  return GET(new Request(`https://www.marketruns.org/api/admin/inbox/${id}/attachments/${idForAttachment}`), {
    params: Promise.resolve({ id, attachmentId: idForAttachment }),
  });
}

beforeEach(() => {
  mocks.list.mockReset();
  mocks.getAttachment.mockReset();
  mocks.send.mockReset().mockResolvedValue({ data: { id: "email_123" }, error: null });
  mocks.session.mockReset();
});

describe("inbound attachments", () => {
  it("lists every attachment page for an existing received email", async () => {
    mocks.list
      .mockResolvedValueOnce({ data: { data: [attachment], has_more: true }, error: null })
      .mockResolvedValueOnce({
        data: { data: [{ ...attachment, id: "6ff6b0d0-159f-46c1-a376-b7dbd65ad437", filename: "identity.png" }], has_more: false },
        error: null,
      });

    const result = await listInboundAttachments(testEnv(), "em_test_123");

    expect(result?.map((item) => item.filename)).toEqual(["verification.pdf", "identity.png"]);
    expect(mocks.list).toHaveBeenNthCalledWith(1, { emailId: "em_test_123", limit: 100 });
    expect(mocks.list).toHaveBeenNthCalledWith(2, { emailId: "em_test_123", limit: 100, after: attachmentId });
  });

  it("returns an unavailable result instead of throwing when Resend fails", async () => {
    mocks.list.mockResolvedValue({ data: null, error: { message: "temporarily unavailable" } });
    await expect(listInboundAttachments(testEnv(), "em_test_123")).resolves.toBeNull();
  });

  it("retrieves a fresh HTTPS download URL", async () => {
    mocks.getAttachment.mockResolvedValue({ data: attachment, error: null });
    await expect(getInboundAttachmentUrl(testEnv(), "em_test_123", attachmentId)).resolves.toBe(downloadUrl);
    expect(mocks.getAttachment).toHaveBeenCalledWith({ emailId: "em_test_123", id: attachmentId });
  });
});

describe("attachment download route", () => {
  it("requires authentication", async () => {
    const env = testEnv();
    const site = await siteWithInbound(env);
    mocks.session.mockResolvedValue({ env, site, user: null });

    const response = await downloadRequest();

    expect(response.status).toBe(401);
    expect(mocks.getAttachment).not.toHaveBeenCalled();
  });

  it("rejects signed-in non-admins", async () => {
    const env = testEnv();
    const site = await siteWithInbound(env);
    mocks.session.mockResolvedValue({ env, site, user: { email: "buyer@example.com" } });

    const response = await downloadRequest();

    expect(response.status).toBe(403);
    expect(mocks.getAttachment).not.toHaveBeenCalled();
  });

  it("redirects an admin to a fresh signed URL without caching it", async () => {
    const env = testEnv();
    const site = await siteWithInbound(env);
    mocks.session.mockResolvedValue({ env, site, user: { email: "admin@marketruns.org" } });
    mocks.getAttachment.mockResolvedValue({ data: attachment, error: null });

    const response = await downloadRequest();

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(downloadUrl);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getAttachment).toHaveBeenCalledWith({ emailId: "em_test_123", id: attachmentId });
  });

  it("returns 502 when the attachment cannot be retrieved", async () => {
    const env = testEnv();
    const site = await siteWithInbound(env);
    mocks.session.mockResolvedValue({ env, site, user: { email: "admin@marketruns.org" } });
    mocks.getAttachment.mockResolvedValue({ data: null, error: { message: "not found" } });

    const response = await downloadRequest();

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "attachment-unavailable" });
  });
});


describe("outgoing reply attachments", () => {
  it("sends multipart reply attachments through Resend and records the reply", async () => {
    const env = testEnv();
    const site = await siteWithInbound(env);
    mocks.session.mockResolvedValue({ env, site, user: { email: "admin@marketruns.org" } });
    const form = new FormData();
    form.set("inboundEmailId", inboundId);
    form.set("html", "<p>Please find the document attached.</p>");
    form.set("text", "Please find the document attached.");
    form.append("attachments", new File(["proof"], "evidence.pdf", { type: "application/pdf" }));

    const response = await postReply(new Request("https://www.marketruns.org/api/admin/replies", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(200);
    const message = mocks.send.mock.calls[0]?.[0];
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({ filename: "evidence.pdf", contentType: "application/pdf" });
    expect(Buffer.from(message.attachments[0].content).toString()).toBe("proof");
    expect(await listEmailReplies(site, inboundId)).toHaveLength(1);
  });

  it("rejects unsupported attachment types before sending", async () => {
    const env = testEnv();
    const site = await siteWithInbound(env);
    mocks.session.mockResolvedValue({ env, site, user: { email: "admin@marketruns.org" } });
    const form = new FormData();
    form.set("inboundEmailId", inboundId);
    form.set("html", "<p>Attached</p>");
    form.set("text", "Attached");
    form.append("attachments", new File(["binary"], "payload.exe", { type: "application/octet-stream" }));

    const response = await postReply(new Request("https://www.marketruns.org/api/admin/replies", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid-attachments" });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(await listEmailReplies(site, inboundId)).toHaveLength(0);
  });

  it("limits replies to five attachments", () => {
    const files = Array.from({ length: 6 }, (_, index) => ({
      name: `document-${index}.pdf`,
      size: 1,
      type: "application/pdf",
    }));
    expect(replyAttachmentError(files)).toBe("Attach no more than 5 files.");
  });

  it("limits the combined attachment size to 4 MB", () => {
    const files = [1, 2].map((index) => ({
      name: `document-${index}.pdf`,
      size: 3 * 1024 * 1024,
      type: "application/pdf",
    }));
    expect(replyAttachmentError(files)).toBe("Attachments must be 4 MB or smaller in total.");
  });
});
