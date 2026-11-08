import { fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app/app.js";
import type { Env } from "../src/config/env.js";
import { bindings, readJson } from "./helpers.js";

const ARCHIVE = "http://localhost:8788";
const INTERNAL_TOKEN = "edge-archive-internal-test-token";

function archiveEnv(token: string | undefined = INTERNAL_TOKEN): Env {
  return { ...bindings, ARCHIVE_INTERNAL_TOKEN: token } as Env;
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterAll(() => fetchMock.deactivate());

describe("edge archive service authentication", () => {
  it("injects only the configured token on Ops admin archive reads", async () => {
    let seenHeaders: Record<string, string> | undefined;
    fetchMock.get(ARCHIVE).intercept({ path: "/admin/runs?limit=50&offset=0" }).reply(200, (opts) => {
      seenHeaders = opts.headers as Record<string, string>;
      return JSON.stringify({ items: [], total: 0, limit: 50, offset: 0 });
    }, { headers: { "content-type": "application/json" } });

    const response = await createApp().fetch(new Request("http://edge/ops/api/admin/runs?limit=50&offset=0", {
      headers: { "x-archive-internal": "client-forged-token" },
    }), archiveEnv());

    expect(response.status).toBe(200);
    expect(seenHeaders?.["x-archive-internal"]).toBe(INTERNAL_TOKEN);
  });

  it("injects the configured token on Ops reputation reads", async () => {
    let seenHeaders: Record<string, string> | undefined;
    fetchMock.get(ARCHIVE).intercept({ path: "/reputation?participant=buyer:1&role=buyer" }).reply(200, (opts) => {
      seenHeaders = opts.headers as Record<string, string>;
      return JSON.stringify({ participantId: "buyer:1", role: "buyer" });
    }, { headers: { "content-type": "application/json" } });

    const response = await createApp().fetch(
      new Request("http://edge/ops/api/reputation?participant=buyer:1&role=buyer"),
      archiveEnv(),
    );

    expect(response.status).toBe(200);
    expect(seenHeaders?.["x-archive-internal"]).toBe(INTERNAL_TOKEN);
  });

  it("injects the configured token on participant active-run discovery", async () => {
    let seenHeaders: Record<string, string> | undefined;
    fetchMock.get(ARCHIVE).intercept({
      path: "/admin/runs?market=archive-auth&runnerId=runner:internal&kind=live&limit=200",
    }).reply(200, (opts) => {
      seenHeaders = opts.headers as Record<string, string>;
      return JSON.stringify({ items: [], total: 0, limit: 200, offset: 0 });
    }, { headers: { "content-type": "application/json" } });

    const response = await createApp().fetch(new Request("http://edge/markets/archive-auth/runs/active", {
      headers: { "x-participant-id": "runner:internal", "x-participant-role": "runner" },
    }), archiveEnv());

    expect(response.status).toBe(200);
    expect((await readJson(response)).warning).toBeUndefined();
    expect(seenHeaders?.["x-archive-internal"]).toBe(INTERNAL_TOKEN);
  });
});
