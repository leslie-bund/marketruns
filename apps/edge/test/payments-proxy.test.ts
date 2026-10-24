import { fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signSessionToken } from "@market-runs/domain";
import type { Env } from "../src/config/env.js";
import { createApp } from "../src/app/app.js";
import { bindings } from "./helpers.js";

const BASE = "http://edge";
const PAYMENTS_ORIGIN = "http://localhost:8790";
const SESSION_SECRET = "payments-proxy-session-test-secret";
const INTERNAL_TOKEN = "payments-proxy-internal-test-token";

function withEnv(overrides: Partial<Env>): Env {
  return new Proxy(bindings, {
    get: (target, prop, receiver) =>
      prop in overrides ? overrides[prop as keyof Env] : Reflect.get(target, prop, receiver),
  }) as Env;
}

async function sellerSession(participantId = "seller:amina"): Promise<string> {
  const now = Date.now();
  return signSessionToken(
    { tokenId: `token-${participantId}`, participantId, role: "seller", iat: now, exp: now + 60_000 },
    SESSION_SECRET,
  );
}

type SeenHeaders = Record<string, string>;

function intercept(path: string, method = "GET"): { seen: () => SeenHeaders | undefined } {
  let seen: SeenHeaders | undefined;
  fetchMock
    .get(PAYMENTS_ORIGIN)
    .intercept({ path, method })
    .reply(200, (opts) => {
      seen = opts.headers as SeenHeaders;
      return JSON.stringify({ ok: true });
    });
  return { seen: () => seen };
}

describe("/payments payout-account participant forwarding", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterAll(() => {
    fetchMock.deactivate();
  });

  it("forwards only the resolved session participant and the configured internal token", async () => {
    const upstream = intercept("/payments/payout-accounts/seller:amina");
    const response = await createApp().fetch(
      new Request(`${BASE}/payments/payout-accounts/seller:amina`, {
        headers: {
          authorization: `Bearer ${await sellerSession()}`,
          "x-participant-id": "seller:attacker",
          "x-participant-role": "runner",
          "x-payments-internal": "client-forged-token",
        },
      }),
      withEnv({ IDENTITY_SESSION_SECRET: SESSION_SECRET, PAYMENTS_INTERNAL_TOKEN: INTERNAL_TOKEN }),
    );

    expect(response.status).toBe(200);
    expect(upstream.seen()?.["x-participant-id"]).toBe("seller:amina");
    expect(upstream.seen()?.["x-participant-role"]).toBe("seller");
    expect(upstream.seen()?.["x-payments-internal"]).toBe(INTERNAL_TOKEN);
  });

  it("rejects a missing session in deployed posture instead of trusting headers", async () => {
    const response = await createApp().fetch(
      new Request(`${BASE}/payments/payout-accounts/seller:amina`, {
        headers: { "x-participant-id": "seller:amina", "x-participant-role": "seller" },
      }),
      withEnv({
        ALLOW_HEADER_AUTH: undefined,
        IDENTITY_SESSION_SECRET: SESSION_SECRET,
        PAYMENTS_INTERNAL_TOKEN: INTERNAL_TOKEN,
      }),
    );

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("unauthorized");
  });

  it("fails closed when a session request has no payments internal token configured", async () => {
    const response = await createApp().fetch(
      new Request(`${BASE}/payments/payout-accounts/seller:amina`, {
        headers: { authorization: `Bearer ${await sellerSession()}` },
      }),
      withEnv({ IDENTITY_SESSION_SECRET: SESSION_SECRET, PAYMENTS_INTERNAL_TOKEN: undefined }),
    );

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe("payments-auth-unconfigured");
  });

  it("keeps explicitly gated header-auth demo forwarding without inventing a token", async () => {
    const upstream = intercept("/payments/payout-accounts/seller:demo");
    const response = await createApp().fetch(
      new Request(`${BASE}/payments/payout-accounts/seller:demo`, {
        headers: { "x-participant-id": "seller:demo", "x-participant-role": "seller" },
      }),
      withEnv({ ALLOW_HEADER_AUTH: "true", PAYMENTS_INTERNAL_TOKEN: undefined }),
    );

    expect(response.status).toBe(200);
    expect(upstream.seen()?.["x-participant-id"]).toBe("seller:demo");
    expect(upstream.seen()?.["x-participant-role"]).toBe("seller");
    expect(upstream.seen()?.["x-payments-internal"]).toBeUndefined();
  });

  it("does not add participant auth to charge confirmation", async () => {
    const upstream = intercept("/payments/charges/confirm", "POST");
    const response = await createApp().fetch(
      new Request(`${BASE}/payments/charges/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txRef: "tx", expectedAmountKobo: 100, buyerId: "buyer:1", cartId: "cart:1" }),
      }),
      withEnv({ ALLOW_HEADER_AUTH: undefined, PAYMENTS_INTERNAL_TOKEN: INTERNAL_TOKEN }),
    );

    expect(response.status).toBe(200);
    expect(upstream.seen()?.["x-payments-internal"]).toBeUndefined();
    expect(upstream.seen()?.["x-participant-id"]).toBeUndefined();
  });
});
