import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../src/env";

afterEach(() => vi.unstubAllEnvs());

describe("loadEnv", () => {
  it("trims whitespace and trailing slashes from SITE_BASE_URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_SECRET", "test-auth-secret-test-auth-secret-32");
    vi.stubEnv("SITE_BASE_URL", "  https://www.marketruns.org/  ");
    vi.stubEnv("SITE_DATABASE_PATH", ":memory:");
    vi.stubEnv("ADMIN_EMAILS", "admin@marketruns.org");

    expect(loadEnv().baseUrl).toBe("https://www.marketruns.org");
  });

  it("trims every environment value without changing intentional internal spaces", () => {
    vi.stubEnv("NODE_ENV", " production ");
    vi.stubEnv("BETTER_AUTH_SECRET", "  test-auth-secret-test-auth-secret-32  ");
    vi.stubEnv("SITE_BASE_URL", " https://www.marketruns.org ");
    vi.stubEnv("SITE_DATABASE_URL", " postgres://user:pass@example.com/db ");
    vi.stubEnv("SITE_DATABASE_PATH", " :memory: ");
    vi.stubEnv("RESEND_API_KEY", " re_test ");
    vi.stubEnv("RESEND_AUDIENCE_ID", " audience_test ");
    vi.stubEnv("RESEND_WEBHOOK_SECRET", " whsec_test ");
    vi.stubEnv("RESEND_FROM_EMAIL", " Market Runs <hello@marketruns.org> ");
    vi.stubEnv("INBOUND_EMAIL_ADDRESS", " hello@marketruns.org ");
    vi.stubEnv("ADMIN_EMAILS", " admin@marketruns.org ");

    const env = loadEnv();
    expect(env).toMatchObject({
      nodeEnv: "production",
      authSecret: "test-auth-secret-test-auth-secret-32",
      baseUrl: "https://www.marketruns.org",
      databaseUrl: "postgres://user:pass@example.com/db",
      databasePath: ":memory:",
      resendApiKey: "re_test",
      resendAudienceId: "audience_test",
      resendWebhookSecret: "whsec_test",
      resendFromEmail: "Market Runs <hello@marketruns.org>",
      inboundEmail: "hello@marketruns.org",
      adminEmails: ["admin@marketruns.org"],
    });
  });
});
