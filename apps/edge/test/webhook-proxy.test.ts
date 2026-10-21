import { SELF, fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readJson } from "./helpers.js";

/**
 * Edge proxies for provider server-to-server calls (ADR-0026): /webhooks/* →
 * the payments worker (PAYMENTS_URL, dev default :8790) and /callbacks/* →
 * the identity worker (IDENTITY_URL, dev default :8789). The edge is a dumb
 * pipe for both — path+query verbatim, body byte-for-byte, inbound headers
 * forwarded (so the upstream's own signature/hash check sees the request as
 * the provider sent it), 503 when the upstream is down. Same fetchMock
 * spy/stub pattern as the ops console proxy tests (ops-admin.test.ts).
 */

const BASE = "http://edge";

interface SeenUpstream {
  path: string;
  method: string;
  headers: unknown;
  body: string;
}

describe("provider callback proxies (edge dumb pipes)", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterAll(() => {
    fetchMock.deactivate();
  });

  it("POST /webhooks/transfers forwards path+query, body, and the verif-hash header verbatim", async () => {
    const payload = JSON.stringify({
      event: "transfer.completed",
      "event.type": "Transfer",
      data: { id: 12345, reference: "abc:def_PMCKDU_1", status: "SUCCESSFUL", complete_message: "Successful" },
    });
    let seen: SeenUpstream | undefined;
    fetchMock
      .get("http://localhost:8790")
      .intercept({ path: "/webhooks/transfers?provider=v3", method: "POST" })
      .reply(200, (opts) => {
        seen = { path: opts.path, method: opts.method, headers: opts.headers, body: String(opts.body) };
        return JSON.stringify({ status: "matched" });
      });

    // No participant headers, no Bearer session — a provider server-to-server POST.
    const response = await SELF.fetch(
      new Request(`${BASE}/webhooks/transfers?provider=v3`, {
        method: "POST",
        headers: { "content-type": "application/json", "verif-hash": "the-configured-secret-hash" },
        body: payload,
      }),
    );

    expect(response.status).toBe(200);
    expect((await readJson(response)).status).toBe("matched");
    expect(seen).toBeDefined();
    expect(seen?.body).toBe(payload); // body byte-for-byte
    const headers = seen?.headers as Record<string, string>;
    // The upstream hash check reads the inbound verif-hash — it must survive the proxy.
    expect(headers["verif-hash"]).toBe("the-configured-secret-hash");
    expect(headers["x-request-id"]).toBeDefined();
    expect(headers.host).toBeUndefined();
  });

  it("POST /webhooks/charges forwards and passes upstream refusals through untouched", async () => {
    fetchMock
      .get("http://localhost:8790")
      .intercept({ path: "/webhooks/charges", method: "POST" })
      .reply(401, JSON.stringify({ error: "invalid-webhook-hash", message: "webhook hash mismatch" }), {
        headers: { "content-type": "application/json" },
      });

    const response = await SELF.fetch(
      new Request(`${BASE}/webhooks/charges`, {
        method: "POST",
        headers: { "content-type": "application/json", "verif-hash": "wrong" },
        body: JSON.stringify({ event: "charge.completed", data: { id: 1, tx_ref: "tx" } }),
      }),
    );
    // The worker's own wire shape passes through — 401 is the upstream's
    // verdict on the hash, not a proxy error.
    expect(response.status).toBe(401);
    expect((await readJson(response)).error).toBe("invalid-webhook-hash");
  });

  it("503 payments-unavailable when the payments worker is down", async () => {
    // No mock registered for this path: outbound fetch is refused.
    const response = await SELF.fetch(
      new Request(`${BASE}/webhooks/transfers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "transfer.completed", data: { id: 1, status: "SUCCESSFUL" } }),
      }),
    );
    expect(response.status).toBe(503);
    expect((await readJson(response)).error).toBe("payments-unavailable");
  });

  it("POST /callbacks/smileid forwards body and headers verbatim to the identity worker", async () => {
    const payload = JSON.stringify({ job_id: "smile-1", result_code: "0810" });
    let seen: SeenUpstream | undefined;
    fetchMock
      .get("http://localhost:8789")
      .intercept({ path: "/callbacks/smileid", method: "POST" })
      .reply(200, (opts) => {
        seen = { path: opts.path, method: opts.method, headers: opts.headers, body: String(opts.body) };
        return JSON.stringify({ ok: true, jobId: "facejob-1", status: "complete" });
      });

    const response = await SELF.fetch(
      new Request(`${BASE}/callbacks/smileid`, {
        method: "POST",
        headers: { "content-type": "application/json", signature: "provider-signature-value" },
        body: payload,
      }),
    );

    expect(response.status).toBe(200);
    expect((await readJson(response)).ok).toBe(true);
    expect(seen?.body).toBe(payload);
    const headers = seen?.headers as Record<string, string>;
    expect(headers.signature).toBe("provider-signature-value");
  });

  it("503 identity-unavailable when the identity worker is down", async () => {
    const response = await SELF.fetch(
      new Request(`${BASE}/callbacks/smileid`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job_id: "smile-2" }),
      }),
    );
    expect(response.status).toBe(503);
    expect((await readJson(response)).error).toBe("identity-unavailable");
  });
});
