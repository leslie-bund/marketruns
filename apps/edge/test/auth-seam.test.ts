import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { requireOps, resolveParticipant } from "../src/app/middleware/participant.js";

/**
 * The auth seam (ADR-0015). Identity enters through one middleware; the wire
 * keeps working for anonymous clients, and an authenticated caller's id is
 * adopted for durable-record attribution when the wire omits buyerId.
 */
describe("participant identity on the wire", () => {
  it("adopts the authenticated caller's id when the wire omits buyerId", async () => {
    const posted = await SELF.fetch(new Request("http://edge/command", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-participant-id": "buyer:from-auth",
        "x-participant-role": "buyer",
      },
      body: JSON.stringify({
        type: "intent.posted",
        intentId: "auth-intent-1",
        shopItem: "Tomatoes",
        quantity: 2,
        unit: "kg",
        priceBand: { minKobo: 120_000, maxKobo: 180_000 },
        market: "auth",
      }),
    }));
    expect(posted.status).toBe(200);

    const intents = await SELF.fetch(new Request("http://edge/markets/auth/intents"));
    const body = (await intents.json()) as { intents: Array<{ buyerId?: string }> };
    expect(body.intents.find((intent) => intent.buyerId === "buyer:from-auth")).toBeDefined();
  });

  it("keeps anonymous clients working without identity headers", async () => {
    const posted = await SELF.fetch(new Request("http://edge/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "intent.posted",
        intentId: "auth-intent-2",
        shopItem: "Tomatoes",
        quantity: 1,
        unit: "kg",
        priceBand: { minKobo: 100_000, maxKobo: 150_000 },
        market: "auth",
      }),
    }));
    expect(posted.status).toBe(200);
  });
});

/** Unit tests for the guard itself — the deployed-enforcement branch. */
describe("requireOps guard", () => {
  function fakeContext(opts: { token?: string; header?: string }) {
    let setValue: unknown;
    return {
      c: {
        env: { OPS_TOKEN: opts.token, ALLOW_HEADER_AUTH: "true" },
        req: { header: (name: string) => (name === "x-ops-token" ? opts.header : undefined) },
        set: (_key: string, value: unknown) => {
          setValue = value;
        },
        json: (body: unknown, status?: number) => ({ body, status }),
      },
      getSet: () => setValue,
    };
  }

  it("rejects adjustments when OPS_TOKEN is set and the header mismatches", async () => {
    const { c } = fakeContext({ token: "secret", header: "wrong" });
    const guard = requireOps();
    const result = (await guard(c as never, async () => {})) as { status: number };
    expect(result.status).toBe(403);
  });

  it("admits ops when the token matches, and labels the local operator in dev", async () => {
    const match = fakeContext({ token: "secret", header: "secret" });
    let ran = false;
    await requireOps()(match.c as never, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect((match.getSet() as { id: string }).id).toBe("ops");

    const dev = fakeContext({});
    await requireOps()(dev.c as never, async () => {
      ran = true;
    });
    expect((dev.getSet() as { id: string }).id).toBe("local-ops");
  });

  it("resolveParticipant reads the dev-stage headers", () => {
    const withRole = fakeContext({});
    withRole.c.req.header = (name: string) =>
      name === "x-participant-id" ? "runner:1" : name === "x-participant-role" ? "runner" : undefined;
    expect(resolveParticipant(withRole.c as never)).toEqual({ id: "runner:1", role: "runner", source: "header" });

    const anon = fakeContext({});
    expect(resolveParticipant(anon.c as never)).toEqual({ id: "anonymous", role: "buyer", source: "anonymous" });
  });
});
