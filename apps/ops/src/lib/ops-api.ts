import type { MarketConfig, OpsMarket, OpsStore, RecoveryAction, RunnerPool, ShopItem } from "./types";

export type { OpsMarket } from "./types";

export interface OpsUser {
  id: string;
  email: string;
  name: string;
  role: "viewer" | "operator" | "admin";
  mustChangePassword: boolean;
}

export class OpsApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "OpsApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const data = await response.json().catch(() => null) as { message?: string; error?: string } | null;
  if (!response.ok) {
    throw new OpsApiError(response.status, data?.message ?? data?.error ?? `Request failed (${response.status})`);
  }
  return data as T;
}

function post<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

function remove<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

const id = (value: string) => encodeURIComponent(value);

export async function getSession(): Promise<OpsUser | null> {
  const data = await request<{ user?: OpsUser } | null>("/ops/auth/get-session");
  return data?.user ?? null;
}

export async function signIn(email: string, password: string): Promise<void> {
  await request("/ops/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email, password }) });
}

export async function sendMagicLink(email: string): Promise<void> {
  await request("/ops/auth/sign-in/magic-link", { method: "POST", body: JSON.stringify({ email, callbackURL: "/" }) });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await request("/ops/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: true }),
  });
}

export async function signOut(): Promise<void> {
  await request("/ops/auth/sign-out", { method: "POST", body: JSON.stringify({}) });
}

export interface OpsAccount extends OpsUser {
  emailVerified: boolean;
  createdAt: string;
}

export async function listOpsUsers(): Promise<{ users: OpsAccount[]; total: number }> {
  return request("/ops/auth/admin/list-users?limit=200&sortBy=createdAt&sortDirection=asc");
}

export async function inviteOpsUser(input: { email: string; name: string; role: OpsUser["role"] }): Promise<void> {
  await post("/ops/auth/admin/create-user", input);
  await sendMagicLink(input.email);
}

export async function setOpsUserRole(userId: string, role: OpsUser["role"]): Promise<void> {
  await post("/ops/auth/admin/set-role", { userId, role });
}

export async function revokeOpsUserSessions(userId: string): Promise<void> {
  await post("/ops/auth/admin/revoke-user-sessions", { userId });
}

export async function listMarkets(): Promise<OpsMarket[]> {
  const data = await request<{ markets: OpsMarket[] }>("/ops/api/markets");
  return data.markets;
}

export interface CreateMarketInput {
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

export async function createMarket(input: CreateMarketInput): Promise<void> {
  await post("/ops/api/markets", {
    name: input.name,
    closeAt: Date.now() + 8 * 60 * 60 * 1000,
    estTripMs: 20 * 60 * 1000,
    bufferMs: 5 * 60 * 1000,
    floorRate: {
      distanceMeters: 3_000,
      estimatedDurationMs: 20 * 60 * 1000,
      baseKobo: 100_000,
      perKilometerKobo: 20_000,
      perMinuteKobo: 500,
    },
    settlement: { goodsCommissionBps: 1_000, deliveryMarginKobo: 10_000 },
    geo: {
      center: { latitude: input.latitude, longitude: input.longitude },
      radiusMeters: input.radiusMeters,
      exchangePoints: [],
      musterPoints: [],
    },
  });
}

export async function updateMarket(market: string, input: { name?: string; active?: boolean }): Promise<void> {
  await patch(`/ops/api/markets/${id(market)}`, input);
}

export async function updateMarketConfig(market: string, config: MarketConfig): Promise<void> {
  await post(`/ops/api/markets/${id(market)}/config`, { ...config, opsConfigured: true });
}

export async function moderateVocabulary(market: string, input: { action: "remove"; item: string } | { action: "rename"; from: string; to: string }): Promise<void> {
  await post(`/ops/api/markets/${id(market)}/vocabulary`, input);
}

export interface SettleRunInput {
  mode: "completed" | "aborted" | "disputed";
  ambiguous?: boolean;
  requestedPlatformLossKobo?: number;
  reason?: string;
}

export async function settleRun(runId: string, input: SettleRunInput): Promise<void> {
  await post(`/ops/api/runs/${id(runId)}/settle`, input);
}

export async function redriveSettlement(settlementId: string): Promise<void> {
  await post(`/ops/api/admin/settlements/${id(settlementId)}/redrive`);
}

export async function replayDispatch(dispatchId: string): Promise<void> {
  await post(`/ops/api/admin/payments/${id(dispatchId)}/replay`);
}

export async function syncDispatch(dispatchId: string): Promise<void> {
  await post(`/ops/api/admin/payments/${id(dispatchId)}/sync`);
}

export interface ResolveRefundInput {
  action: "accept-provider" | "complete-manual" | "allow-retry";
  status?: "processing" | "completed";
  providerRef?: string;
  evidenceRef: string;
  note: string;
}

export async function resolveRefund(refundId: string, input: ResolveRefundInput): Promise<void> {
  await post(`/ops/api/admin/refunds/${id(refundId)}/resolution`, input);
}

export async function executeRecoveryAction(action: RecoveryAction): Promise<void> {
  if (action.type === "replay-dispatch") return replayDispatch(action.targetId);
  if (action.type === "sync-dispatch") return syncDispatch(action.targetId);
  if (action.type === "redrive-settlement") return redriveSettlement(action.targetId);
  throw new Error("Refund resolution requires evidence and a note.");
}

export interface CreateStoreInput {
  marketId: string;
  sellerId: string;
  name: string;
  exchangePoint: string;
}

export async function createStore(input: CreateStoreInput): Promise<void> {
  await post("/ops/api/stores", input);
}

export async function updateStore(store: string, input: Partial<CreateStoreInput>): Promise<OpsStore> {
  const data = await patch<{ store: OpsStore }>(`/ops/api/stores/${id(store)}`, input);
  return data.store;
}

export async function deleteStore(store: string): Promise<void> {
  await remove(`/ops/api/stores/${id(store)}`);
}

export async function createShopItem(store: string, input: { name: string; attributes: Record<string, unknown>; active: boolean }): Promise<void> {
  await post(`/ops/api/stores/${id(store)}/items`, input);
}

export async function updateShopItem(store: string, item: string, input: Partial<Pick<ShopItem, "name" | "attributes" | "active">>): Promise<void> {
  await patch(`/ops/api/stores/${id(store)}/items/${id(item)}`, input);
}

export async function deleteShopItem(store: string, item: string): Promise<void> {
  await remove(`/ops/api/stores/${id(store)}/items/${id(item)}`);
}

export async function createRunnerPool(input: { marketId: string; name: string; active: boolean }): Promise<void> {
  await post("/ops/api/runner-pools", input);
}

export async function updateRunnerPool(pool: string, input: Partial<{ marketId: string; name: string; active: boolean }>): Promise<RunnerPool> {
  const data = await patch<{ pool: RunnerPool }>(`/ops/api/runner-pools/${id(pool)}`, input);
  return data.pool;
}

export async function deleteRunnerPool(pool: string): Promise<void> {
  await remove(`/ops/api/runner-pools/${id(pool)}`);
}

export async function addRunner(pool: string, runner: string): Promise<void> {
  await request(`/ops/api/runner-pools/${id(pool)}/members/${id(runner)}`, { method: "PUT", body: JSON.stringify({}) });
}

export async function removeRunner(pool: string, runner: string): Promise<void> {
  await remove(`/ops/api/runner-pools/${id(pool)}/members/${id(runner)}`);
}

export async function decideDeviceReset(resetId: string, decision: "approved" | "rejected", revokeSessions: boolean): Promise<void> {
  await post(`/ops/api/device-resets/${id(resetId)}/decision`, { decision, revokeSessions });
}
