import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";

/**
 * Request correlation (x-request-id) on the identity worker: honored when
 * well-formed, generated otherwise, echoed on the response, and logged as one
 * parseable JSON line per request.
 */
describe("identity x-request-id", () => {
  it("honors and echoes a well-formed inbound id, logging one JSON line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await worker.fetch(
        new Request("http://identity/healthz", { headers: { "x-request-id": "rid-ident-1" } }),
        {} as Env,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("x-request-id")).toBe("rid-ident-1");
      expect(log).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(log.mock.calls[0]?.[0] as string) as Record<string, unknown>;
      expect(parsed).toMatchObject({ requestId: "rid-ident-1", method: "GET", path: "/healthz", status: 200 });
      expect(typeof parsed.ms).toBe("number");
    } finally {
      log.mockRestore();
    }
  });

  it("generates an id when absent and when malformed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const absent = await worker.fetch(new Request("http://identity/healthz"), {} as Env);
      expect(absent.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);

      const malformed = await worker.fetch(
        new Request("http://identity/healthz", { headers: { "x-request-id": "has spaces" } }),
        {} as Env,
      );
      expect(malformed.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      log.mockRestore();
    }
  });
});
