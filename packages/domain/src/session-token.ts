/**
 * Session tokens — PURE (packages/domain doctrine: no platform imports).
 *
 * Compact HMAC-SHA256 signed tokens issued by the identity worker
 * (apps/identity) after a successful face verification or device-key
 * authentication, and verified by ANY worker that holds the shared secret:
 *
 *   token = base64url(json(payload)) "." base64url(hmac-sha256(payloadBytes))
 *
 * Why HMAC instead of a per-request call back to the identity worker: the
 * edge verifies locally with zero added latency and no availability
 * coupling (an identity-worker outage must not take down every
 * authenticated marketplace request). The cost is that revocation is not
 * instantaneous — mitigated by the 12h TTL and by the identity worker
 * recording every token in auth_sessions so /auth/session/validate remains
 * available as the authoritative check when revocation matters (device
 * reset, disputes). WebCrypto only — no node:crypto (Workers runtime).
 *
 * `role` stays a plain string here: domain has no dependencies and proto
 * owns the wire enum (SessionTokenPayloadSchema).
 */

export const SESSION_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h

export interface SessionTokenPayload {
  /** Token id (jti) — recorded in auth_sessions so ops can revoke. */
  tokenId: string;
  participantId: string;
  role: string;
  /** Issued-at, epoch ms. */
  iat: number;
  /** Expiry, epoch ms. */
  exp: number;
}

export type SessionVerification =
  | { ok: true; payload: SessionTokenPayload }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlDecode(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signSessionToken(
  payload: SessionTokenPayload,
  secret: string,
): Promise<string> {
  const body = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body));
  return `${body}.${base64urlEncode(new Uint8Array(signature))}`;
}

/** Verify signature and expiry. `now` is epoch ms (injectable for tests). */
export async function verifySessionToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): Promise<SessionVerification> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: "malformed" };
  const body = token.slice(0, dot);
  let signature: Uint8Array;
  try {
    signature = base64urlDecode(token.slice(dot + 1));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature as BufferSource,
    new TextEncoder().encode(body),
  );
  if (!valid) return { ok: false, reason: "bad-signature" };
  let payload: SessionTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlDecode(body))) as SessionTokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload.tokenId !== "string" ||
    typeof payload.participantId !== "string" ||
    typeof payload.role !== "string" ||
    !Number.isFinite(payload.iat) ||
    !Number.isFinite(payload.exp)
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (now >= payload.exp) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}
