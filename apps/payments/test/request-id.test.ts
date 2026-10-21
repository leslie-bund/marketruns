import { describe, expect, it, vi } from "vitest";
import { createPaymentsApp } from "../src/index.js";
import { StubDispatcher } from "../src/dispatcher.js";
import { InMemoryDispatchStore } from "./helpers.js";

/**
 * Request correlation (x-request-id) on the payments worker: honored when
 * well-formed, generated otherwise, echoed on the response, and logged as one
 * parseable JSON line per request.
 */
describe("payments x-request-id", () => {
  it("honors and echoes a well-formed inbound id, logging one JSON line", async () => {
    const app = createPaymentsApp(new InMemoryDispatchStore(), new StubDispatcher());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await app.fetch(
        new Request("http://payments/healthz", { headers: { "x-request-id": "rid-pay-1" } }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("x-request-id")).toBe("rid-pay-1");
      expect(log).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(log.mock.calls[0]?.[0] as string) as Record<string, unknown>;
      expect(parsed).toMatchObject({ requestId: "rid-pay-1", method: "GET", path: "/healthz", status: 200 });
      expect(typeof parsed.ms).toBe("number");
    } finally {
      log.mockRestore();
    }
  });

  it("generates an id when absent and when malformed", async () => {
    const app = createPaymentsApp(new InMemoryDispatchStore(), new StubDispatcher());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const absent = await app.fetch(new Request("http://payments/healthz"));
      expect(absent.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);

      const malformed = await app.fetch(
        new Request("http://payments/healthz", { headers: { "x-request-id": "has spaces" } }),
      );
      expect(malformed.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      log.mockRestore();
    }
  });
});
