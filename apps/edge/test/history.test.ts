import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchMock } from "cloudflare:test";
import { signSessionToken } from "@market-runs/domain";
import { createApp } from "../src/app/app.js";
import type { Env } from "../src/config/env.js";
import { bindings } from "./helpers.js";

const BASE = "http://edge";

describe("participant history", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterAll(() => fetchMock.deactivate());

  it("requires a session", async () => {
    const response = await createApp().fetch(new Request(`${BASE}/history`), bindings);
    expect(response.status).toBe(401);
  });

  it("derives the archive filter from the caller and returns validated history", async () => {
    const now = Date.now();
    const token = await signSessionToken({
      tokenId: "history-session", participantId: "participant:buyer-history", role: "buyer", iat: now, exp: now + 60_000,
    }, "market-runs-dev-session-secret");
    let path = "";
    fetchMock.get("http://localhost:8788").intercept({ path: /\/participant\/history.*/ }).reply(200, (options) => {
      path = String(options.path);
      return { carts: [], sales: [], runs: [] };
    }, { headers: { "content-type": "application/json" } });
    const env = new Proxy(bindings, {
      get: (target, property, receiver) => property === "IDENTITY_SESSION_SECRET" ? "market-runs-dev-session-secret" : Reflect.get(target, property, receiver),
    }) as Env;

    const response = await createApp().fetch(new Request(`${BASE}/history`, { headers: { authorization: `Bearer ${token}` } }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ carts: [], sales: [], runs: [] });
    expect(path).toContain(`participantId=${encodeURIComponent("participant:buyer-history")}`);
    expect(path).toContain("role=buyer");
  });
});
