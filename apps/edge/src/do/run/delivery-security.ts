import type { Env } from "../../config/env.js";
import type { InternalHandoff } from "./state.js";

export const DELIVERY_CODE_TTL_MS = 60 * 60 * 1000;
export const DELIVERY_CODE_MAX_ATTEMPTS = 5;
const DEV_CODE_SECRET = "market-runs-local-delivery-code-secret";

function secret(env: Env): string {
  const configured = env.IDENTITY_SESSION_SECRET;
  if (configured) return configured;
  if (env.ALLOW_HEADER_AUTH === "true") return DEV_CODE_SECRET;
  throw new Error("IDENTITY_SESSION_SECRET is required for delivery handoff codes");
}

async function digest(env: Env, purpose: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`market-runs:${purpose}:${secret(env)}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Deterministic re-issuance lets the authenticated buyer recover the code without plaintext server storage. */
export async function issueDeliveryCode(env: Env, runId: string, issuedAt: number): Promise<{ code: string; hash: string }> {
  const bytes = await digest(env, "delivery-code-issue", `${runId}:${issuedAt}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const code = String(view.getUint32(0) % 1_000_000).padStart(6, "0");
  return { code, hash: await hashDeliveryCode(env, runId, code) };
}

export async function hashDeliveryCode(env: Env, runId: string, code: string): Promise<string> {
  return hex(await digest(env, "delivery-code-verify", `${runId}:${code}`));
}

export async function pickupChallenge(env: Env, runId: string, handoff: InternalHandoff): Promise<string> {
  return base64Url(await digest(env, "pickup-challenge", `${runId}:${handoff.id}:${handoff.requestedAt}`));
}

export function secretsEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
