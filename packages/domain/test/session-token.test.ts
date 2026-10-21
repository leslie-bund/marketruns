import { describe, expect, it } from "vitest";
import { SESSION_TOKEN_TTL_MS, signSessionToken, verifySessionToken } from "../src/session-token.js";

const SECRET = "test-session-secret";
const now = 1_800_000_000_000;

function payload(overrides: Partial<{ exp: number }> = {}) {
  return {
    tokenId: "tok-1",
    participantId: "participant-1",
    role: "buyer",
    iat: now,
    exp: now + SESSION_TOKEN_TTL_MS,
    ...overrides,
  };
}

describe("session tokens", () => {
  it("signs and verifies a token round trip", async () => {
    const token = await signSessionToken(payload(), SECRET);
    const result = await verifySessionToken(token, SECRET, now + 1000);
    expect(result).toEqual({ ok: true, payload: payload() });
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSessionToken(payload(), SECRET);
    const result = await verifySessionToken(token, "wrong-secret", now + 1000);
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a tampered payload", async () => {
    const token = await signSessionToken(payload(), SECRET);
    const [, sig] = token.split(".");
    const forgedBody = btoa(JSON.stringify({ ...payload(), role: "ops" }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    const result = await verifySessionToken(`${forgedBody}.${sig}`, SECRET, now + 1000);
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects an expired token at exp, and accepts one just before", async () => {
    const token = await signSessionToken(payload(), SECRET);
    expect(await verifySessionToken(token, SECRET, now + SESSION_TOKEN_TTL_MS)).toEqual({
      ok: false,
      reason: "expired",
    });
    const justBefore = await verifySessionToken(token, SECRET, now + SESSION_TOKEN_TTL_MS - 1);
    expect(justBefore.ok).toBe(true);
  });

  it("rejects malformed tokens", async () => {
    expect(await verifySessionToken("", SECRET, now)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifySessionToken("nosdot", SECRET, now)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifySessionToken(".sig", SECRET, now)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifySessionToken("body.", SECRET, now)).toEqual({ ok: false, reason: "malformed" });
    // A properly-signed body that isn't a valid payload still fails closed.
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const badBody = btoa("not json").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const junkSig = await crypto.subtle.sign("HMAC", key, encoder.encode(badBody));
    let binary = "";
    for (const b of new Uint8Array(junkSig)) binary += String.fromCharCode(b);
    const junkToken = `${badBody}.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
    expect(await verifySessionToken(junkToken, SECRET, now)).toEqual({ ok: false, reason: "malformed" });
  });
});
