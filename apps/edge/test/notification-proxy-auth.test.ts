import { fetchMock } from "cloudflare:test";
import { signSessionToken } from "@market-runs/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app/app.js";
import type { Env } from "../src/config/env.js";
import { bindings } from "./helpers.js";

const SESSION_SECRET = "notification-proxy-session-test-secret";
const PARTICIPANT_ID = "buyer:notification-proxy-auth";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterAll(() => fetchMock.deactivate());

async function authorizedRequest(path: string, method: "GET" | "POST" = "GET"): Promise<Request> {
  const now = Date.now();
  const session = await signSessionToken({
    tokenId: "token:notification-proxy-auth",
    participantId: PARTICIPANT_ID,
    role: "buyer",
    iat: now,
    exp: now + 60_000,
  }, SESSION_SECRET);
  return new Request(`http://edge/notifications${path}`, {
    method,
    headers: {
      authorization: `Bearer ${session}`,
      "x-notification-internal": "client-forged-token",
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify({ ids: ["notification:1"] }) } : {}),
  });
}

function proxyEnv(token?: string): Env {
  return {
    ...bindings,
    ALLOW_HEADER_AUTH: "false",
    IDENTITY_SESSION_SECRET: SESSION_SECRET,
    NOTIFICATION_INTERNAL_TOKEN: token,
  } as Env;
}

describe("edge notification durable-read service authentication", () => {
  it("fails closed before list or read-state proxying when service auth is absent", async () => {
    const list = await createApp().fetch(await authorizedRequest(""), proxyEnv());
    expect(list.status).toBe(503);
    expect(await list.json()).toMatchObject({ error: "notification-auth-unconfigured" });

    const markRead = await createApp().fetch(await authorizedRequest("/read", "POST"), proxyEnv());
    expect(markRead.status).toBe(503);
    expect(await markRead.json()).toMatchObject({ error: "notification-auth-unconfigured" });
  });

  it("injects only the configured service token on list and read-state calls", async () => {
    const seenHeaders: Array<Record<string, string>> = [];
    const pool = fetchMock.get("http://localhost:8791");
    pool.intercept({ path: "/notifications", method: "GET" }).reply(200, (opts) => {
      seenHeaders.push(opts.headers as Record<string, string>);
      return JSON.stringify({ items: [], total: 0, unread: 0, limit: 50, offset: 0 });
    }, { headers: { "content-type": "application/json" } });
    pool.intercept({ path: "/notifications/read", method: "POST" }).reply(200, (opts) => {
      seenHeaders.push(opts.headers as Record<string, string>);
      return JSON.stringify({ updated: 1 });
    }, { headers: { "content-type": "application/json" } });

    const token = "configured-notification-internal-token";
    const list = await createApp().fetch(await authorizedRequest(""), proxyEnv(token));
    expect(list.status).toBe(200);
    const markRead = await createApp().fetch(await authorizedRequest("/read", "POST"), proxyEnv(token));
    expect(markRead.status).toBe(200);
    expect(seenHeaders).toHaveLength(2);
    expect(seenHeaders.map((headers) => headers["x-notification-internal"])).toEqual([token, token]);
  });
});
