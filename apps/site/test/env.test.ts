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
});
