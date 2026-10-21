import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import type { Env } from "../src/config/env.js";
import {
  correlationHeaders,
  requestLogLine,
  resolveRequestId,
} from "../src/app/middleware/request-id.js";
import { forwardTo } from "../src/app/routes/markets.js";

/**
 * Request correlation (x-request-id): generated when absent, honored when
 * well-formed, echoed on every response, and threaded onto internal DO
 * fetches. The structured request log line is pinned by shape.
 */
describe("x-request-id middleware", () => {
  it("generates an id when the request carries none and echoes it", async () => {
    const response = await SELF.fetch(new Request("http://edge/healthz"));
    const id = response.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("honors a well-formed inbound id and echoes it back", async () => {
    const response = await SELF.fetch(
      new Request("http://edge/healthz", { headers: { "x-request-id": "trace-2026-06-12.1" } }),
    );
    expect(response.headers.get("x-request-id")).toBe("trace-2026-06-12.1");
  });

  it("replaces a malformed inbound id with a generated one", async () => {
    const response = await SELF.fetch(
      new Request("http://edge/healthz", { headers: { "x-request-id": "bad id with spaces" } }),
    );
    const id = response.headers.get("x-request-id");
    expect(id).not.toBe("bad id with spaces");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("echoes the id on error responses too", async () => {
    const response = await SELF.fetch(
      new Request("http://edge/no-such-route", { headers: { "x-request-id": "trace-404" } }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("x-request-id")).toBe("trace-404");
  });
});

describe("correlation helpers", () => {
  it("resolveRequestId honors the safe charset and length bound", () => {
    expect(resolveRequestId("abc-123_X.Y:Z")).toBe("abc-123_X.Y:Z");
    expect(resolveRequestId("")).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveRequestId("x".repeat(65))).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveRequestId("semi;colon")).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("correlationHeaders sets x-request-id merged over extras", () => {
    const c = { get: (key: string) => (key === "requestId" ? "rid-1" : undefined) } as unknown as Context<{
      Bindings: Env;
    }>;
    const headers = correlationHeaders(c, { "x-market-id": "Balogun" });
    expect(headers.get("x-request-id")).toBe("rid-1");
    expect(headers.get("x-market-id")).toBe("Balogun");
  });

  it("forwardTo threads the request id onto the DO fetch", async () => {
    const seen: Array<string | null> = [];
    const stub = {
      fetch: async (request: Request) => {
        seen.push(request.headers.get("x-request-id"));
        return Response.json({ ok: true });
      },
    } as unknown as DurableObjectStub;
    const c = {
      req: {
        raw: new Request("http://edge/markets/Balogun/intents?open=1"),
        method: "GET",
        url: "http://edge/markets/Balogun/intents?open=1",
      },
      get: (key: string) => (key === "requestId" ? "rid-forward" : undefined),
    } as unknown as Context<{ Bindings: Env }>;
    const response = await forwardTo(c, stub, "/intents");
    expect(response.status).toBe(200);
    expect(seen).toEqual(["rid-forward"]);
  });

  it("forwardTo overrides a spoofed inbound id with the context id", async () => {
    const seen: Array<string | null> = [];
    const stub = {
      fetch: async (request: Request) => {
        seen.push(request.headers.get("x-request-id"));
        return Response.json({ ok: true });
      },
    } as unknown as DurableObjectStub;
    const c = {
      req: {
        raw: new Request("http://edge/markets/Balogun/config", { headers: { "x-request-id": "inbound" } }),
        method: "GET",
        url: "http://edge/markets/Balogun/config",
      },
      get: (key: string) => (key === "requestId" ? "inbound" : undefined),
    } as unknown as Context<{ Bindings: Env }>;
    await forwardTo(c, stub, "/config");
    expect(seen).toEqual(["inbound"]);
  });
});

describe("request log line", () => {
  it("is a single JSON line with the required keys", () => {
    const line = requestLogLine({
      requestId: "rid-1",
      method: "POST",
      path: "/command",
      status: 200,
      ms: 12,
      participantId: "buyer:1",
    });
    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toEqual({
      requestId: "rid-1",
      method: "POST",
      path: "/command",
      status: 200,
      ms: 12,
      participantId: "buyer:1",
    });
  });

  it("omits participantId when the caller is unresolved", () => {
    const parsed = JSON.parse(
      requestLogLine({ requestId: "rid-2", method: "GET", path: "/healthz", status: 200, ms: 0 }),
    ) as Record<string, unknown>;
    expect(parsed).toEqual({ requestId: "rid-2", method: "GET", path: "/healthz", status: 200, ms: 0 });
  });
});
