import { fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeviceResetListResponseSchema } from "@market-runs/proto";
import type { Env } from "../src/config/env.js";
import { createApp } from "../src/app/app.js";
import { bindings } from "./helpers.js";

/**
 * The ops console's device-reset queue (ADR-0022's ops-approved reset):
 * /ops/api/device-resets* proxy the identity worker's requireInternal seam —
 * x-identity-internal injected when IDENTITY_INTERNAL_TOKEN is set (the SAME
 * scope as the /auth/* proxy), the list response is validated fail-closed
 * against its proto schema, and upstream refusals (404/409) pass through.
 * Everything sits behind requireOps like every /ops/api/* route.
 */

const BASE = "http://edge";
const IDENTITY_ORIGIN = "http://localhost:8789";
const INTERNAL_TOKEN = "edge-identity-internal-test-token";
const OPS_TOKEN = "ops-test-token";

/** Test bindings with selected env vars overridden. */
function withEnv(overrides: Record<string, string>): Env {
  return new Proxy(bindings, {
    get: (target, prop, receiver) =>
      typeof prop === "string" && prop in overrides ? overrides[prop] : Reflect.get(target, prop, receiver),
  }) as Env;
}

function getOps(path: string, env: Env, headers: Record<string, string> = {}): Promise<Response> {
  return createApp().fetch(new Request(`${BASE}${path}`, { headers }), env);
}

function postOps(path: string, body: unknown, env: Env, headers: Record<string, string> = {}): Promise<Response> {
  return createApp().fetch(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );
}

const QUEUE_PAYLOAD = {
  requests: [
    {
      id: "req-1",
      participantId: "buyer:ada",
      reason: "lost my phone at the market",
      status: "pending",
      createdAt: 1_700_000_000_000,
      resolvedAt: null,
      resolvedBy: null,
    },
  ],
};

describe("ops console device-reset proxies", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterAll(() => {
    fetchMock.deactivate();
  });

  it("lists pending resets, passing the query through and injecting the internal token", async () => {
    let seen: Record<string, string> | undefined;
    fetchMock
      .get(IDENTITY_ORIGIN)
      .intercept({ path: "/auth/device-reset?status=pending", method: "GET" })
      .reply(200, (opts) => {
        seen = opts.headers as Record<string, string>;
        return JSON.stringify(QUEUE_PAYLOAD);
      });

    const response = await getOps("/ops/api/device-resets?status=pending", withEnv({ IDENTITY_INTERNAL_TOKEN: INTERNAL_TOKEN }));
    expect(response.status).toBe(200);
    expect(seen?.["x-identity-internal"]).toBe(INTERNAL_TOKEN);
    // The body validates against the proto wire shape and passes through.
    const body = await response.json();
    expect(DeviceResetListResponseSchema.safeParse(body).success).toBe(true);
    expect((body as typeof QUEUE_PAYLOAD).requests[0]?.participantId).toBe("buyer:ada");
  });

  it("injects nothing when IDENTITY_INTERNAL_TOKEN is unset (dev posture)", async () => {
    let seen: Record<string, string> | undefined;
    fetchMock
      .get(IDENTITY_ORIGIN)
      .intercept({ path: "/auth/device-reset?status=pending", method: "GET" })
      .reply(200, (opts) => {
        seen = opts.headers as Record<string, string>;
        return JSON.stringify({ requests: [] });
      });

    const response = await getOps("/ops/api/device-resets?status=pending", bindings);
    expect(response.status).toBe(200);
    expect(seen?.["x-identity-internal"]).toBeUndefined();
  });

  it("fails closed with 502 when the identity list response fails schema validation", async () => {
    fetchMock
      .get(IDENTITY_ORIGIN)
      .intercept({ path: "/auth/device-reset?status=pending", method: "GET" })
      .reply(200, JSON.stringify({ requests: [{ nope: true }] }), { headers: { "content-type": "application/json" } });

    const response = await getOps("/ops/api/device-resets?status=pending", bindings);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toBe("bad-identity-response");
  });

  it("503s identity-unavailable when the identity service does not respond", async () => {
    // No mock registered: outbound fetch is refused under disableNetConnect.
    const response = await getOps("/ops/api/device-resets?status=pending", bindings);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe("identity-unavailable");
  });

  it("posts decisions through with the internal token, and passes upstream refusals through", async () => {
    let seenHeaders: Record<string, string> | undefined;
    let seenBody: string | undefined;
    fetchMock
      .get(IDENTITY_ORIGIN)
      .intercept({ path: "/auth/device-reset/req-1/decision", method: "POST" })
      .reply(200, (opts) => {
        seenHeaders = opts.headers as Record<string, string>;
        seenBody = String(opts.body);
        return JSON.stringify({
          id: "req-1",
          participantId: "buyer:ada",
          status: "approved",
          createdAt: 1_700_000_000_000,
          resolvedAt: 1_700_000_100_000,
          revokedCredentials: 1,
          revokedSessions: 2,
        });
      });
    fetchMock
      .get(IDENTITY_ORIGIN)
      .intercept({ path: "/auth/device-reset/req-done/decision", method: "POST" })
      .reply(409, JSON.stringify({ error: "reset-already-resolved", message: "request already approved" }), {
        headers: { "content-type": "application/json" },
      });

    const env = withEnv({ IDENTITY_INTERNAL_TOKEN: INTERNAL_TOKEN });
    const decided = await postOps("/ops/api/device-resets/req-1/decision", { decision: "approved" }, env);
    expect(decided.status).toBe(200);
    expect(seenHeaders?.["x-identity-internal"]).toBe(INTERNAL_TOKEN);
    expect(JSON.parse(seenBody ?? "{}")).toEqual({ decision: "approved" });
    const body = (await decided.json()) as { status: string; revokedSessions: number };
    expect(body.status).toBe("approved");
    expect(body.revokedSessions).toBe(2);

    // A double resolution surfaces the identity worker's own 409 untouched.
    const again = await postOps("/ops/api/device-resets/req-done/decision", { decision: "rejected" }, env);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("reset-already-resolved");
  });

  it("400s invalid decision bodies before they reach the identity worker", async () => {
    const bad = await postOps("/ops/api/device-resets/req-1/decision", { decision: "maybe" }, bindings);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid-body");
  });

  it("sits behind the requireOps guard when OPS_TOKEN is set", async () => {
    fetchMock
      .get(IDENTITY_ORIGIN)
      .intercept({ path: "/auth/device-reset?status=pending", method: "GET" })
      .reply(200, JSON.stringify({ requests: [] }), { headers: { "content-type": "application/json" } });

    const env = withEnv({ OPS_TOKEN: OPS_TOKEN });
    const refused = await getOps("/ops/api/device-resets?status=pending", env);
    expect(refused.status).toBe(403);

    const admitted = await getOps("/ops/api/device-resets?status=pending", env, { "x-ops-token": OPS_TOKEN });
    expect(admitted.status).toBe(200);

    // The decision route is guarded too.
    const refusedDecision = await postOps("/ops/api/device-resets/req-1/decision", { decision: "approved" }, env);
    expect(refusedDecision.status).toBe(403);
  });
});
