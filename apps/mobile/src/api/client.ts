import type { ActiveRunsResponse, Cart, CheckoutAccepted, DiscoveryResponse, Intent, IntentDiscoveryEntry, Participant, PriceMove, Product, Run, Store } from "@market-runs/proto";
import { identities, EDGE_URL, newId } from "./config";
import { getActiveMarket } from "./active-market";
import { getActiveParticipant, participantHeaders } from "./participant";
import { clearSession, sessionHeaders } from "./auth";
import { getActiveStore } from "./active-store";
import { clearCartId, clearRunId, getStoredCartId, getStoredRunId, recordCartId, recordRunId } from "./cart-state";

/**
 * The real API client — every method maps one-to-one onto the public edge
 * wire (see packages/proto for the message shapes). Errors surface the
 * server's JSON message so screens can show *why* a command was refused
 * (close gate, cart deadline, accept-once...) instead of a generic failure.
 *
 * Identity: every request carries the onboarded participant's headers — the
 * edge's single auth seam (ADR-0015) resolves them, and /command adopts the
 * caller's id for buyer attribution when the wire omits it (ADR-0014). Before
 * a device onboards, the demo identities keep the market explorable.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${EDGE_URL}${path}`, {
    ...init,
    // A live session rides as Bearer alongside the participant headers — the
    // edge prefers a valid session, the headers remain the dev/demo path.
    headers: { "content-type": "application/json", ...sessionHeaders(), ...participantHeaders(), ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const code = String(body.error ?? "unknown");
    if (response.status === 401 && (code === "session-expired" || code === "session-invalid")) {
      // The server killed the cached session — drop it so screens fall back
      // to the "sign in again" state via the session listeners.
      void clearSession();
    }
    throw new ApiError(response.status, code, String(body.message ?? response.statusText));
  }
  return body as T;
}

const command = <T = Record<string, unknown>>(body: unknown): Promise<T> =>
  request<T>("/command", { method: "POST", body: JSON.stringify(body) });

/** The wire omits buyerId once a participant is onboarded — the edge adopts the caller's identity. */
function buyerAttribution(): { buyerId?: string } {
  const participant = getActiveParticipant();
  if (participant) return {};
  return { buyerId: identities.buyer.id };
}

/**
 * Demo explore mode sends no participant headers, but header-keyed reads (the
 * per-buyer cart) still need the demo buyer identity the commands adopt.
 */
function demoBuyerHeaders(): Record<string, string> {
  return getActiveParticipant() ? {} : { "x-participant-id": identities.buyer.id, "x-participant-role": "buyer" };
}

/**
 * Same fallback for the runner surface: before this device onboards, run
 * discovery identifies as the internal runner pool (MVP assigns every run to
 * runner:internal, ADR-0013).
 */
function demoRunnerHeaders(): Record<string, string> {
  return getActiveParticipant() ? {} : { "x-participant-id": identities.runner.id, "x-participant-role": "runner" };
}

/**
 * Same fallback for the seller surface: before this device onboards, run
 * discovery presents the demo seller role so the edge takes the store-scoped
 * branch (the store itself is identified by the storeId query param).
 */
function demoSellerHeaders(): Record<string, string> {
  return getActiveParticipant() ? {} : { "x-participant-id": identities.seller.id, "x-participant-role": "seller" };
}

/* ------------------------------------------------------------------ */
/* Participants & markets                                              */
/* ------------------------------------------------------------------ */

/** Onboard with KYC (ADR-0004): BVN/NIN + facial capture through the verifier seam. */
export async function onboardParticipant(input: {
  role: "buyer" | "seller" | "runner";
  displayName: string;
  idDocumentType: "bvn" | "nin";
  idDocument: string;
  facialCaptureRef: string;
  market: string;
}): Promise<Participant> {
  const body = await command<{ participant: Participant }>({
    type: "participant.onboarded",
    participantId: newId("participant"),
    ...input,
  });
  return body.participant;
}

/** Join another market (idempotent). */
export async function joinMarket(market: string): Promise<void> {
  const participant = getActiveParticipant();
  if (!participant) throw new ApiError(400, "no-participant", "Onboard first, then join markets.");
  await command({
    type: "market.joined",
    market,
    participantId: participant.id,
    role: participant.role,
  });
}

/** The zone registry: every market anyone has joined. */
export async function listMarkets(): Promise<Array<{ id: string }>> {
  const body = await request<{ markets: Array<{ id: string }> }>("/markets");
  return body.markets;
}

export async function getParticipant(participantId: string): Promise<Participant | null> {
  try {
    const body = await request<{ participant: Participant }>(`/participants/${encodeURIComponent(participantId)}`);
    return body.participant;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Buyer                                                               */
/* ------------------------------------------------------------------ */

export async function listIntents(shopItems?: string[] | null): Promise<Intent[]> {
  const scope = shopItems && shopItems.length > 0 ? `?shopItems=${encodeURIComponent(shopItems.join(","))}` : "";
  const body = await request<{ intents: Intent[] }>(`/markets/${encodeURIComponent(getActiveMarket())}/intents${scope}`);
  return body.intents;
}

/**
 * The filtered discovery read (proto/discovery.ts): one call returns the open
 * intents in the caller's scope WITH their live products inline — the end of
 * the all-intents + per-intent-products fan-out.
 *
 * Seller scope: intents whose shop item the store supplies (ADR-0006 — the
 * vocabulary is the room; a seller literally only receives intents for items
 * they listed).
 */
export async function discoverIntentsForItems(shopItems: string[]): Promise<IntentDiscoveryEntry[]> {
  if (shopItems.length === 0) return [];
  const query = `?shopItems=${encodeURIComponent(shopItems.join(","))}`;
  const body = await request<DiscoveryResponse>(`/markets/${encodeURIComponent(getActiveMarket())}/discovery${query}`);
  return body.intents;
}

/**
 * Buyer scope of the same discovery read: only the caller's own intents
 * ("buyers only ask for what they typed"). The identity rides the participant
 * headers the edge's auth seam resolves (ADR-0015); demo explore mode sends
 * the demo buyer identity explicitly, exactly like getCart.
 */
export async function discoverMyIntents(): Promise<IntentDiscoveryEntry[]> {
  const body = await request<DiscoveryResponse>(`/markets/${encodeURIComponent(getActiveMarket())}/discovery`, {
    headers: demoBuyerHeaders(),
  });
  return body.intents;
}

/** The market's item vocabulary — the union of what its stores supply (ADR-0006). */
export async function listVocabulary(): Promise<string[]> {
  const body = await request<{ shopItems: string[] }>(`/markets/${encodeURIComponent(getActiveMarket())}/vocabulary`);
  return body.shopItems;
}

/** Buyer discovery: every live product offered against an intent. */
export async function listIntentProducts(intentId: string): Promise<Product[]> {
  const { productIds } = await request<{ productIds: string[] }>(
    `/markets/${encodeURIComponent(getActiveMarket())}/intents/${encodeURIComponent(intentId)}/products`,
  );
  const products = await Promise.all(
    productIds.map(async (id) => {
      try {
        const body = await request<{ product: Product }>(`/products/${encodeURIComponent(id)}`);
        return body.product;
      } catch {
        return null; // retired or unknown — products are never resurrected
      }
    }),
  );
  return products.filter((product): product is Product => product !== null);
}

export async function postIntent(input: {
  shopItem: string;
  quantity: number;
  unit: string;
  priceBand: { minKobo: number; maxKobo: number };
  note?: string;
}): Promise<Intent> {
  const body = await command<{ intent: Intent }>({
    type: "intent.posted",
    intentId: newId("intent"),
    ...input,
    market: getActiveMarket(),
    ...buyerAttribution(),
  });
  return body.intent;
}

export interface ProductThread {
  product: Product;
  /** The negotiation thread so far: the initial offer plus every adjustment. */
  priceHistory: PriceMove[];
}

export async function getProduct(productId: string): Promise<ProductThread | null> {
  try {
    const body = await request<{ product: Product; priceHistory?: PriceMove[] }>(`/products/${encodeURIComponent(productId)}`);
    return { product: body.product, priceHistory: body.priceHistory ?? [] };
  } catch {
    return null;
  }
}

export async function buyerOffer(productId: string, priceKobo: number): Promise<void> {
  await command({ type: "negotiation.price-adjusted", productId, by: "buyer", priceKobo, at: Date.now() });
}

export async function acceptProduct(productId: string): Promise<Cart> {
  const body = await command<{ cart: Cart }>({ type: "product.accepted", productId });
  // Primary source of the cart id: the edge-issued cart.updated payload.
  void recordCartId(body.cart.market, body.cart.id);
  return body.cart;
}

/**
 * The caller's own cart in the active market, keyed off the identity headers
 * (carts are per buyer: `cart:<market>:<buyerId>`). This is the re-discovery
 * path after an app restart or market switch; 404 means no open cart.
 */
export async function getCart(): Promise<Cart | null> {
  const market = getActiveMarket();
  try {
    const body = await request<{ cart: Cart }>(`/markets/${encodeURIComponent(market)}/cart`, { headers: demoBuyerHeaders() });
    // Only an open cart is checkout-able; a retired/checked-out id is dead weight.
    if (body.cart.status === "open") void recordCartId(market, body.cart.id);
    else void clearCartId(market);
    return body.cart;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) void clearCartId(market);
    return null;
  }
}

export async function checkout(
  delivery: { kind: "plus-code"; plusCode: string } | { kind: "muster-point"; name: string },
  paymentRef?: string,
): Promise<CheckoutAccepted> {
  const market = getActiveMarket();
  const cartId = getStoredCartId(market);
  if (!cartId) throw new ApiError(400, "no-cart", "Your cart is empty — accept a product before checkout.");
  const accepted = await command<CheckoutAccepted>({
    type: "checkout.requested",
    cartId,
    ...buyerAttribution(),
    delivery,
    // The confirmed hold's txRef — required only when the edge runs with
    // PAYMENTS_REQUIRED on; absent keeps the unpaid dev checkout working.
    ...(paymentRef ? { paymentRef } : {}),
  });
  // checkout.accepted echoes the run id; the cart retires at checkout.
  void recordRunId(market, accepted.runId);
  return accepted;
}

/* ------------------------------------------------------------------ */
/* Seller                                                              */
/* ------------------------------------------------------------------ */

/**
 * Register the device's store when joining the market (GLOSSARY: Store). The
 * store's shop items grow the market vocabulary and scope which intents reach
 * this seller.
 */
export async function registerStore(input: {
  name: string;
  exchangePoint: string;
  shopItems: string[];
}): Promise<Store> {
  const body = await command<{ store: Store }>({
    type: "store.registered",
    storeId: newId("store"),
    market: getActiveMarket(),
    ...input,
  });
  return body.store;
}

export async function offerProduct(input: {
  intentId: string;
  shopItem: string;
  quantity: number;
  unit: string;
  priceKobo: number;
  photoCaptureRef?: string;
}): Promise<Product> {
  const productId = newId("product");
  // The store is the seller's identity on the wire (GLOSSARY); the demo
  // identity is the fallback before this device joins the market.
  const store = getActiveStore();
  const sellerName = store?.name ?? identities.seller.name;
  const exchangePoint = store?.exchangePoint ?? identities.seller.exchangePoint;
  const body = await request<{ product: Product }>(`/markets/${encodeURIComponent(getActiveMarket())}/offers`, {
    method: "POST",
    body: JSON.stringify({
      productId,
      ...input,
      market: getActiveMarket(),
      sellerName,
      exchangePoint,
    }),
  });
  return body.product;
}

export async function sellerOffer(productId: string, priceKobo: number): Promise<void> {
  await command({ type: "negotiation.price-adjusted", productId, by: "seller", priceKobo, at: Date.now() });
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

/**
 * Live-run discovery: the device's live runs in the active market, from the
 * edge's client-safe read of the live_runs index. This is how a device that
 * never saw the checkout finds its run. Two scopes: a runner call (no scope)
 * matches the caller's runner id; a seller call (`{ storeId }`) matches runs
 * containing that store — the store's trading identity as it appears on the
 * run's products (sellerName), which is what the seller device knows from
 * its cached active store. The index is not doctrine: any failure (edge
 * down, index unavailable) degrades to an empty list and the screen falls
 * back to its own stored run id / empty state.
 */
export async function listActiveRuns(scope?: { storeId?: string }): Promise<ActiveRunsResponse> {
  const storeId = scope?.storeId;
  const query = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
  try {
    return await request<ActiveRunsResponse>(
      `/markets/${encodeURIComponent(getActiveMarket())}/runs/active${query}`,
      { headers: storeId ? demoSellerHeaders() : demoRunnerHeaders() },
    );
  } catch {
    return { runs: [] };
  }
}

/**
 * Every run command takes the edge-issued run id explicitly (learned from
 * `checkout.accepted.runId` and kept in the device cart state) — the app
 * never derives one.
 */
export async function getRun(runId: string): Promise<Run | null> {
  try {
    const body = await request<{ run: Run }>(`/runs/${encodeURIComponent(runId)}`);
    return body.run;
  } catch (error) {
    // A 404 means the run retired and its storage is gone — heal the device state.
    if (error instanceof ApiError && error.status === 404 && getStoredRunId(getActiveMarket()) === runId) {
      void clearRunId(getActiveMarket());
    }
    return null;
  }
}

/**
 * The run's buyer, read back out of the edge-issued run id
 * (`run:cart:<market>:<buyerId>` — the run stays 1:1 with its cart). This
 * never constructs an id; it attributes a run the edge already issued.
 */
export function buyerIdForRun(run: Run): string | null {
  const prefix = `run:cart:${run.market}:`;
  return run.id.startsWith(prefix) ? run.id.slice(prefix.length) : null;
}

export async function initiateHandoff(runId: string, input: { handoffId: string; exchangePointId: string; counterparty: string }): Promise<void> {
  await request(`/runs/${encodeURIComponent(runId)}/handoffs`, { method: "POST", body: JSON.stringify(input) });
}

/** The runner scanned the one-time QR challenge at the exchange point. */
export async function scanChallenge(runId: string, handoffId: string): Promise<void> {
  await command({ type: "handoff.challenge-scanned", handoffId, runId, scannedAt: Date.now() });
}

/** Photo evidence: the signed R2 reference is what the RunDO stores. */
export async function attachPhoto(runId: string, handoffId: string, photoCaptureRef: string): Promise<void> {
  await request(`/runs/${encodeURIComponent(runId)}/handoffs/${encodeURIComponent(handoffId)}/photo`, {
    method: "POST",
    body: JSON.stringify({ type: "handoff.photo-captured", handoffId, photoCaptureRef, capturedAt: Date.now() }),
  });
}

export async function finalDelivery(runId: string): Promise<void> {
  await request(`/runs/${encodeURIComponent(runId)}/delivery/final`, { method: "POST", body: "{}" });
}

export async function locationTick(runId: string, latitude: number, longitude: number): Promise<void> {
  await command({ type: "run.location-updated", runId, latitude, longitude, observedAt: Date.now() });
}

/**
 * The buyer reports a problem inside the dispute window (GLOSSARY: Dispute →
 * settlement pauses for human evidence). The edge adopts the caller's
 * identity headers as raisedByParticipantId; a second dispute is a 409.
 * `evidenceRefs` are the capture references the disputant is relying on
 * (ADR-0007: evidence-first) — the RunDO merges them with every handoff
 * photo ref the run already holds.
 */
export async function fileDispute(
  runId: string,
  reason: string,
  evidenceRefs: string[] = [],
): Promise<{ disputed: boolean; reason: string; raisedByParticipantId: string | null; evidenceRefs: string[] }> {
  return request(`/runs/${encodeURIComponent(runId)}/dispute`, {
    method: "POST",
    headers: demoBuyerHeaders(),
    body: JSON.stringify({ reason, evidenceRefs }),
  });
}

/* ------------------------------------------------------------------ */
/* Captures (camera-only media → R2 via the edge capture endpoint)      */
/* ------------------------------------------------------------------ */

/**
 * Upload camera bytes to the capture endpoint; returns the signed reference
 * the domain stores (never bytes) plus a read-back URL for previews.
 */
export async function uploadCapture(localUri: string): Promise<{ ref: string; url: string }> {
  const blob = await (await fetch(localUri)).blob();
  const response = await fetch(`${EDGE_URL}/captures`, {
    method: "POST",
    headers: { "content-type": blob.type || "image/jpeg", ...participantHeaders() },
    body: blob,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(response.status, String(body.error ?? "unknown"), String(body.message ?? "capture upload failed"));
  }
  return { ref: String(body.ref), url: `${EDGE_URL}${String(body.url)}` };
}

/** Read-back URL for a stored capture reference (r2://archive/captures/x.jpg → edge URL). */
export function captureUrl(ref: string): string {
  return `${EDGE_URL}/captures/${encodeURIComponent(ref.replace(/^r2:\/\/archive\//, ""))}`;
}
