import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { parseArchiveMessage } from "../src/messages.js";

/**
 * Request correlation (x-request-id) on the archive worker: honored when
 * well-formed, generated otherwise, echoed on the response, and logged as one
 * parseable JSON line per request. Queue messages carry the id optionally
 * (append-only) and it survives parsing.
 */
describe("archive x-request-id", () => {
  it("honors and echoes a well-formed inbound id, logging one JSON line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await worker.fetch(
        new Request("http://archive/healthz", { headers: { "x-request-id": "rid-arch-1" } }),
        {} as Env,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("x-request-id")).toBe("rid-arch-1");
      expect(log).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(log.mock.calls[0]?.[0] as string) as Record<string, unknown>;
      expect(parsed).toMatchObject({ requestId: "rid-arch-1", method: "GET", path: "/healthz", status: 200 });
      expect(typeof parsed.ms).toBe("number");
    } finally {
      log.mockRestore();
    }
  });

  it("generates an id when absent and when malformed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const absent = await worker.fetch(new Request("http://archive/healthz"), {} as Env);
      expect(absent.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);

      const malformed = await worker.fetch(
        new Request("http://archive/healthz", { headers: { "x-request-id": "has spaces" } }),
        {} as Env,
      );
      const id = malformed.headers.get("x-request-id");
      expect(id).not.toBe("has spaces");
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      log.mockRestore();
    }
  });

  it("keeps requestId through queue message parsing", () => {
    const withId = parseArchiveMessage(
      JSON.stringify({
        type: "run.started",
        runId: "run:cart:Balogun:buyer:1",
        market: "Balogun",
        status: "assigned",
        runnerId: "runner:internal",
        buyerId: "buyer:1",
        startedAt: 1,
        stopCount: 1,
        storeIds: ["Amina's Fresh Store"],
        requestId: "rid-arch-1",
      }),
    );
    expect(withId.success).toBe(true);
    if (withId.success) expect(withId.data.requestId).toBe("rid-arch-1");

    // Absent stays valid (append-only), malformed ids dead-letter as before.
    const without = parseArchiveMessage(
      JSON.stringify({
        type: "run.started",
        runId: "run:cart:Balogun:buyer:1",
        market: "Balogun",
        status: "assigned",
        runnerId: "runner:internal",
        buyerId: "buyer:1",
        startedAt: 1,
        stopCount: 1,
        storeIds: [],
      }),
    );
    expect(without.success).toBe(true);
    if (without.success) expect(without.data.requestId).toBeUndefined();
  });
});
