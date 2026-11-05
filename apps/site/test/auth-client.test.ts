import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSiteAuthClient } from "../src/auth-client";

const fetchMock = vi.fn();
let authClient: ReturnType<typeof createSiteAuthClient>;

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  authClient = createSiteAuthClient("http://localhost:8795");
});

afterEach(() => vi.unstubAllGlobals());

describe("Better Auth client", () => {
  it("signs out with a JSON POST and credentials", async () => {
    await authClient.signOut();
    const [url, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/api/auth/sign-out");
    expect(request.method).toBe("POST");
    expect(request.credentials).toBe("include");
    expect(new Headers(request.headers).get("content-type")).toBe("application/json");
    expect(request.body).toBe("{}");
  });

  it("requests a magic link through the plugin", async () => {
    await authClient.signIn.magicLink({ email: "admin@marketruns.org", callbackURL: "/admin/inbox" });
    const [url, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/api/auth/sign-in/magic-link");
    expect(JSON.parse(String(request.body))).toEqual({ email: "admin@marketruns.org", callbackURL: "/admin/inbox" });
  });
});
