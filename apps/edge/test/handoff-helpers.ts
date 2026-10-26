import { SELF } from "cloudflare:test";
import { expect } from "vitest";
import { readJson } from "./helpers.js";

export const BASE = "http://edge";
export const RUNNER = "runner:internal";
export const SELLER = "seller:handoff";

export function identity(id: string, role: "buyer" | "seller" | "runner"): Record<string, string> {
  return { "x-participant-id": id, "x-participant-role": role };
}

export async function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));
}

export async function getJson(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(new Request(`${BASE}${path}`, { headers }));
}

export async function driveToRun(
  market: string,
  buyerId: string,
  receiver: { kind: "buyer" } | { kind: "designated"; name: string } = { kind: "buyer" },
): Promise<{ runId: string; code: string; expiresAt: number }> {
  const intentId = `intent-${market}`;
  const productId = `product-${market}`;
  const buyer = identity(buyerId, "buyer");
  expect((await postJson("/command", {
    type: "intent.posted", intentId, shopItem: "Tomatoes", quantity: 2, unit: "kg",
    priceBand: { minKobo: 120_000, maxKobo: 180_000 }, note: "firm and ripe", market,
  }, buyer)).status).toBe(200);
  expect((await postJson(`/markets/${market}/offers`, {
    productId, intentId, market, shopItem: "Tomatoes", quantity: 2, unit: "kg",
    priceKobo: 165_000, sellerName: "Amina's Fresh Store", sellerParticipantId: SELLER,
    exchangePoint: `${market} Market, Stall B14`,
  })).status).toBe(200);
  expect((await postJson("/command", { type: "product.accepted", productId }, buyer)).status).toBe(200);
  const checkout = await postJson("/command", {
    type: "checkout.requested", cartId: `cart:${market}:${buyerId}`,
    delivery: { kind: "plus-code", plusCode: "6FR5+8X Lagos" }, receiver,
  }, buyer);
  expect(checkout.status).toBe(200);
  const accepted = await readJson(checkout);
  expect(String(accepted.deliveryCode)).toMatch(/^\d{6}$/);
  expect(JSON.stringify(accepted)).not.toContain("deliveryCodeHash");
  return { runId: String(accepted.runId), code: String(accepted.deliveryCode), expiresAt: Number(accepted.deliveryCodeExpiresAt) };
}

export async function initiate(
  runId: string,
  handoffId: string,
  handoffType: "pickup" | "delivery",
  exchangePointId: string,
  counterparty: string,
): Promise<Response> {
  return postJson(`/runs/${runId}/handoffs`, { handoffId, handoffType, exchangePointId, counterparty }, identity(RUNNER, "runner"));
}

export async function photo(runId: string, handoffId: string, ref = `r2://archive/captures/${handoffId}.jpg`): Promise<Response> {
  return postJson(`/runs/${runId}/handoffs/${handoffId}/photo`, {
    type: "handoff.photo-captured", handoffId, photoCaptureRef: ref, capturedAt: 1,
  }, identity(RUNNER, "runner"));
}

export async function scan(runId: string, handoffId: string, challenge: string): Promise<Response> {
  return postJson("/command", { type: "handoff.challenge-scanned", handoffId, runId, challenge }, identity(RUNNER, "runner"));
}

export async function pickupChallenge(runId: string, handoffId: string): Promise<string> {
  const response = await getJson(`/runs/${runId}/handoffs/${handoffId}/challenge`, identity(SELLER, "seller"));
  expect(response.status).toBe(200);
  return String((await readJson(response)).challenge);
}

export async function completePickup(runId: string, market: string, handoffId = `${market}-pickup`): Promise<void> {
  expect((await initiate(runId, handoffId, "pickup", `${market} Market, Stall B14`, "Amina's Fresh Store")).status).toBe(200);
  const challenge = await pickupChallenge(runId, handoffId);
  expect((await scan(runId, handoffId, challenge)).status).toBe(409);
  expect((await photo(runId, handoffId)).status).toBe(200);
}

export async function openDelivery(runId: string, buyerId: string, handoffId = `${buyerId}-delivery`, receiverName?: string): Promise<void> {
  expect((await initiate(runId, handoffId, "delivery", "6FR5+8X Lagos", receiverName ?? buyerId)).status).toBe(200);
}

export async function confirm(runId: string, handoffId: string, buyerId?: string): Promise<Response> {
  return postJson(`/runs/${runId}/handoffs/${handoffId}/confirm`, {}, buyerId ? identity(buyerId, "buyer") : identity(RUNNER, "runner"));
}

export async function runView(runId: string, buyerId: string): Promise<Record<string, unknown>> {
  const response = await getJson(`/runs/${runId}`, identity(buyerId, "buyer"));
  expect(response.status).toBe(200);
  return (await readJson(response)).run as Record<string, unknown>;
}
