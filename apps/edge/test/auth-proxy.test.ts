import { fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signSessionToken } from "@market-runs/domain";
import type { Env } from "../src/config/env.js";
import { createApp } from "../src/app/app.js";
import { bindings, readJson } from "./helpers.js";

/**
 * The /auth/* proxy's scoped internal-token injection (ADR-0022). The
 * identity worker guards POST /auth/face/enroll, GET /auth/device-reset (the
 * ops queue read), and POST /auth/device-reset/:id/decision with
 * requireInternal: when IDENTITY_INTERNAL_TOKEN is set the edge must inject
 * it as `x-identity-internal` on those routes ONLY (the secret never rides
 * unrelated /auth/* routes — and never on the PUBLIC POST
 * /auth/device-reset request route); unset is the dev posture — nothing
 * injected. Same fetchMock + env-override (withOpsToken) patterns as
 * webhook-proxy.test.ts / ops-admin.test.ts; each test intercepts its own
 * upstream path.
 */

const BASE = "http://edge";
const IDENTITY_ORIGIN = "http://localhost:8789";
const TOKEN = "edge-identity-internal-test-token";

/** Test bindings with explicit overrides, independent of real local .dev.vars secrets. */
function withEnv(overrides: Record<string, string | undefined>): Env {
  return new Proxy(bindings, {
    get: (target, prop, receiver) =>
      typeof prop === "string" && prop in overrides ? overrides[prop] : Reflect.get(target, prop, receiver),
  }) as Env;
}
function withInternalToken(token: string | undefined): Env {
  return withEnv({ IDENTITY_INTERNAL_TOKEN: token });
}

type SeenHeaders = Record<string, string>;

/** Intercept one upstream POST and capture the headers the proxy sent. */
function interceptPost(path: string): { seen: () => SeenHeaders | undefined } {
  let seen: SeenHeaders | undefined;
  fetchMock
    .get(IDENTITY_ORIGIN)
    .intercept({ path, method: "POST" })
    .reply(200, (opts) => {
      seen = opts.headers as SeenHeaders;
      return JSON.stringify({ ok: true });
    });
  return { seen: () => seen };
}

/** Intercept one upstream GET and capture the headers the proxy sent. */
function interceptGet(path: string): { seen: () => SeenHeaders | undefined } {
  let seen: SeenHeaders | undefined;
  fetchMock
    .get(IDENTITY_ORIGIN)
    .intercept({ path, method: "GET" })
    .reply(200, (opts) => {
      seen = opts.headers as SeenHeaders;
      return JSON.stringify({ requests: [] });
    });
  return { seen: () => seen };
}

function postAuth(path: string, env: Env): Promise<Response> {
  return createApp().fetch(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env,
  );
}

function getAuth(path: string, env: Env): Promise<Response> {
  return createApp().fetch(new Request(`${BASE}${path}`), env);
}

describe("/auth/* proxy x-identity-internal injection", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterAll(() => {
    fetchMock.deactivate();
  });

  it("injects the token on POST /auth/face/enroll when IDENTITY_INTERNAL_TOKEN is set", async () => {
    const enroll = interceptPost("/auth/face/enroll");
    const response = await postAuth("/auth/face/enroll", withInternalToken(TOKEN));
    expect(response.status).toBe(200);
    expect(enroll.seen()?.["x-identity-internal"]).toBe(TOKEN);
  });

  it("injects the token on POST /auth/device-reset/:id/decision when IDENTITY_INTERNAL_TOKEN is set", async () => {
    const decision = interceptPost("/auth/device-reset/req-1/decision");
    const response = await postAuth("/auth/device-reset/req-1/decision", withInternalToken(TOKEN));
    expect(response.status).toBe(200);
    expect(decision.seen()?.["x-identity-internal"]).toBe(TOKEN);
  });

  it("injects the token on GET /auth/device-reset (the reset queue read) when IDENTITY_INTERNAL_TOKEN is set", async () => {
    const queue = interceptGet("/auth/device-reset?status=pending");
    const response = await getAuth("/auth/device-reset?status=pending", withInternalToken(TOKEN));
    expect(response.status).toBe(200);
    expect(queue.seen()?.["x-identity-internal"]).toBe(TOKEN);
  });

  it("never sends the token on unguarded /auth/* routes, even when set", async () => {
    const verify = interceptPost("/auth/face/verify");
    const resetRequest = interceptPost("/auth/device-reset");
    const env = withInternalToken(TOKEN);
    expect((await postAuth("/auth/face/verify", env)).status).toBe(200);
    expect((await postAuth("/auth/device-reset", env)).status).toBe(200);
    expect(verify.seen()?.["x-identity-internal"]).toBeUndefined();
    expect(resetRequest.seen()?.["x-identity-internal"]).toBeUndefined();
  });

  it("sends nothing on the guarded routes when IDENTITY_INTERNAL_TOKEN is unset (dev posture)", async () => {
    const decision = interceptPost("/auth/device-reset/req-2/decision");
    const response = await postAuth("/auth/device-reset/req-2/decision", withInternalToken(undefined));
    expect(response.status).toBe(200);
    expect(decision.seen()?.["x-identity-internal"]).toBeUndefined();

    const queue = interceptGet("/auth/device-reset?status=pending");
    const listed = await getAuth("/auth/device-reset?status=pending", withInternalToken(undefined));
    expect(listed.status).toBe(200);
    expect(queue.seen()?.["x-identity-internal"]).toBeUndefined();
  });

  it("forwards the live session on the final onboarding display-name PATCH", async () => {
    let authorization: unknown;
    let displayName: unknown;
    const at = Date.now();
    const token = await signSessionToken({
      tokenId: "session-final-onboarding", participantId: "participant-final", role: "buyer", iat: at, exp: at + 60_000,
    }, "market-runs-dev-session-secret");
    fetchMock.get(IDENTITY_ORIGIN).intercept({ path: "/auth/identity/participant-final/display-name", method: "PATCH" }).reply(200, (opts) => {
      authorization = (opts.headers as Record<string, unknown>).authorization;
      displayName = (JSON.parse(String(opts.body)) as { displayName?: string }).displayName;
      return { participantId: "participant-final", displayName: "Confirmed Name" };
    });
    const response = await createApp().fetch(new Request(`${BASE}/auth/identity/participant-final/display-name`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ displayName: "Confirmed Name" }),
    }), withEnv({ IDENTITY_SESSION_SECRET: "market-runs-dev-session-secret" }));
    expect(response.status).toBe(200);
    expect(authorization).toBe(`Bearer ${token}`);
    expect(displayName).toBe("Confirmed Name");
    expect((await readJson(response)).displayName).toBe("Confirmed Name");
  });
});
