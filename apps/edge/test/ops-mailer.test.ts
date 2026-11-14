import { describe, expect, it, vi } from "vitest";
import { opsMagicLinkUrl, sendOpsMagicLinkEmail } from "../src/ops-console/mailer.js";

const env = {
  RESEND_API_KEY: "re_test_not_a_real_credential",
  RESEND_FROM_EMAIL: "Market Runs <hello@updates.marketruns.org>",
  OPS_BASE_URL: "https://edge.marketruns.test",
  OPS_DASHBOARD_URL: "https://ops.marketruns.org",
};

describe("ops magic-link email", () => {
  it("keeps the Better Auth token and callback on the dedicated dashboard", () => {
    const link = new URL(opsMagicLinkUrl(
      env,
      "https://edge.marketruns.test/ops/auth/magic-link/verify?token=secret-token&callbackURL=%2F",
    ));

    expect(link.origin).toBe("https://ops.marketruns.org");
    expect(link.pathname).toBe("/ops/auth/magic-link/verify");
    expect(link.searchParams.get("token")).toBe("secret-token");
    expect(link.searchParams.get("callbackURL")).toBe("/");
  });

  it("sends a single-use ten-minute link through Resend", async () => {
    const delivery = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "email-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await sendOpsMagicLinkEmail(
      env,
      "founder@marketruns.org",
      "https://edge.marketruns.test/ops/auth/magic-link/verify?token=secret-token&callbackURL=%2F",
      delivery,
    );

    expect(delivery).toHaveBeenCalledOnce();
    const [url, init] = delivery.mock.calls[0]!;
    expect(String(url)).toBe("https://api.resend.com/emails");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${env.RESEND_API_KEY}`);
    const message = JSON.parse(String(init?.body));
    expect(message.from).toBe(env.RESEND_FROM_EMAIL);
    expect(message.to).toEqual(["founder@marketruns.org"]);
    expect(message.subject).toContain("Market Runs Ops");
    expect(message.text).toContain("https://ops.marketruns.org/ops/auth/magic-link/verify?token=secret-token&callbackURL=%2F");
    expect(message.text).toContain("10 minutes");
    expect(message.html).toContain("Sign in to Market Runs Ops");
  });

  it("fails visibly when Resend rejects the message", async () => {
    const delivery = vi.fn<typeof fetch>(async () => new Response(null, { status: 403 }));

    await expect(sendOpsMagicLinkEmail(env, "founder@marketruns.org", "https://edge.marketruns.test/ops/auth/magic-link/verify?token=token", delivery))
      .rejects.toThrow("Resend could not send the ops magic link (403)");
  });
});
