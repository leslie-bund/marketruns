import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { EDGE_URL } from "./config";

/**
 * Identity sessions and device credentials — the client side of the identity
 * worker, reached through the edge's /auth/* proxy. Three pieces of device
 * state, each with exactly one home:
 *
 * - Auth session (AsyncStorage `market-runs:auth-session`): the bearer token
 *   returned by face verify or device-key authenticate. The wire client
 *   attaches it as `Authorization: Bearer` on every request while it's cached
 *   and unexpired — the edge prefers a valid session over the dev participant
 *   headers, which stay attached either way (ADR-0015's seam does not move).
 *   A session the server rejects (401 session-expired / session-invalid) is
 *   cleared here and the listener set drops screens back to "sign in again".
 * - Device credential id (AsyncStorage `market-runs:device-credential`): the
 *   server-issued credentialId from device-key registration. Not secret —
 *   useless without the secret below.
 * - Device secret (expo-secure-store, key `market-runs.device-secret`): the
 *   actual key material. SecureStore only (Keychain / Keystore), NEVER plain
 *   AsyncStorage on a real device. Expo web has no SecureStore backend, so
 *   dev-on-web falls back to AsyncStorage under a key flagged insecure.
 *
 * Errors carry the server's code and full body (`details`) so screens can
 * surface banded results honestly — e.g. face-mismatch ships a
 * similarityBucket, never a raw score.
 */

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface AuthSession {
  token: string;
  tokenId: string;
  /** Server-issued expiry, epoch millis. */
  expiresAt: number;
}

export interface DeviceCredentialRef {
  participantId: string;
  credentialId: string;
}

/* ------------------------------------------------------------------ */
/* Session cache (mirrors the active-participant pattern)              */
/* ------------------------------------------------------------------ */

const SESSION_KEY = "market-runs:auth-session";

let sessionCache: AuthSession | null = null;
let sessionLoaded = false;
const sessionListeners = new Set<(session: AuthSession | null) => void>();

/** The cached session, or null when missing/expired (expiry is honored client-side too). */
export function getSession(): AuthSession | null {
  return sessionCache && sessionCache.expiresAt > Date.now() ? sessionCache : null;
}

export async function loadSession(): Promise<AuthSession | null> {
  const raw = await AsyncStorage.getItem(SESSION_KEY).catch(() => null);
  sessionCache = raw ? (JSON.parse(raw) as AuthSession) : null;
  sessionLoaded = true;
  return getSession();
}

async function setSessionCache(session: AuthSession | null): Promise<void> {
  sessionCache = session;
  sessionLoaded = true;
  if (session) await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session)).catch(() => undefined);
  else await AsyncStorage.removeItem(SESSION_KEY).catch(() => undefined);
  const live = getSession();
  for (const listener of sessionListeners) listener(live);
}

/** Sign-out / session death: drop the cached token and notify screens. */
export async function clearSession(): Promise<void> {
  await setSessionCache(null);
}

/** The auth header for the wire client — empty when there's no live session. */
export function sessionHeaders(): Record<string, string> {
  const session = getSession();
  return session ? { authorization: `Bearer ${session.token}` } : {};
}

/** Reactive read for screens: re-renders when a session lands or dies. */
export function useAuthSession(): { session: AuthSession | null; loading: boolean } {
  const [session, setSession] = useState<AuthSession | null>(getSession());
  const [loading, setLoading] = useState(!sessionLoaded);

  useEffect(() => {
    void loadSession().then((next) => {
      setSession(next);
      setLoading(false);
    });
    const listener = (next: AuthSession | null) => setSession(next);
    sessionListeners.add(listener);
    return () => {
      sessionListeners.delete(listener);
    };
  }, []);

  return { session, loading };
}

/* ------------------------------------------------------------------ */
/* Device credential: cached id (AsyncStorage) + secret (SecureStore)  */
/* ------------------------------------------------------------------ */

const CREDENTIAL_KEY = "market-runs:device-credential";
// SecureStore keys allow only letters, digits, ".", "-", "_" — no ":".
const SECRET_KEY = "market-runs.device-secret";
const SECRET_FALLBACK_KEY = "market-runs:device-secret-INSECURE-dev-web";

let credentialCache: DeviceCredentialRef | null = null;
let credentialLoaded = false;
const credentialListeners = new Set<() => void>();

export function getCachedDeviceCredential(): DeviceCredentialRef | null {
  return credentialCache;
}

export async function loadDeviceCredential(): Promise<DeviceCredentialRef | null> {
  const raw = await AsyncStorage.getItem(CREDENTIAL_KEY).catch(() => null);
  credentialCache = raw ? (JSON.parse(raw) as DeviceCredentialRef) : null;
  credentialLoaded = true;
  return credentialCache;
}

async function setCredentialCache(credential: DeviceCredentialRef | null): Promise<void> {
  credentialCache = credential;
  credentialLoaded = true;
  if (credential) await AsyncStorage.setItem(CREDENTIAL_KEY, JSON.stringify(credential)).catch(() => undefined);
  else await AsyncStorage.removeItem(CREDENTIAL_KEY).catch(() => undefined);
  for (const listener of credentialListeners) listener();
}

/**
 * Dev identity reset drops the cached credentialId — the SecureStore secret
 * deliberately stays: clearing it would orphan the server-side credential row
 * (a dev server with upsert disabled would then answer 409 credential-exists
 * on re-register, with no way back but a device reset). Note the server row
 * may linger after reset; revoke it server-side if that matters.
 */
export async function clearDeviceCredentialCache(): Promise<void> {
  await setCredentialCache(null);
}

export function useDeviceCredential(): { credential: DeviceCredentialRef | null; loading: boolean } {
  const [credential, setCredential] = useState<DeviceCredentialRef | null>(credentialCache);
  const [loading, setLoading] = useState(!credentialLoaded);

  useEffect(() => {
    void loadDeviceCredential().then((next) => {
      setCredential(next);
      setLoading(false);
    });
    const listener = () => setCredential(credentialCache);
    credentialListeners.add(listener);
    return () => {
      credentialListeners.delete(listener);
    };
  }, []);

  return { credential, loading };
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => void } }).crypto;
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    // Dev-grade fallback — Hermes and web both ship getRandomValues in practice.
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Read the device secret, generating and storing it on first use. */
async function getOrCreateDeviceSecret(): Promise<string> {
  try {
    const existing = await SecureStore.getItemAsync(SECRET_KEY);
    if (existing) return existing;
    const secret = randomSecret();
    await SecureStore.setItemAsync(SECRET_KEY, secret);
    return secret;
  } catch {
    // Expo web has no SecureStore backend — dev-only fallback, flagged in the key.
    const existing = await AsyncStorage.getItem(SECRET_FALLBACK_KEY).catch(() => null);
    if (existing) return existing;
    const secret = randomSecret();
    await AsyncStorage.setItem(SECRET_FALLBACK_KEY, secret).catch(() => undefined);
    return secret;
  }
}

async function readDeviceSecret(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(SECRET_KEY);
  } catch {
    return AsyncStorage.getItem(SECRET_FALLBACK_KEY).catch(() => null);
  }
}

/* ------------------------------------------------------------------ */
/* /auth/* wire calls (raw fetch — the wire client imports this module */
/* for session headers, so going through client.ts would be a cycle)   */
/* ------------------------------------------------------------------ */

async function authRequest<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${EDGE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new AuthError(response.status, String(parsed.error ?? "unknown"), String(parsed.message ?? response.statusText), parsed);
  }
  return parsed as T;
}

async function authGet<T>(path: string): Promise<T> {
  const response = await fetch(`${EDGE_URL}${path}`, { headers: { "content-type": "application/json" } });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new AuthError(response.status, String(parsed.error ?? "unknown"), String(parsed.message ?? response.statusText), parsed);
  }
  return parsed as T;
}

export interface FaceEnrollResponse {
  participantId: string;
  enrolled: boolean;
  modelVersion: string;
  enrolledAt: number;
}

/**
 * Async mode (vendor-held verifier, e.g. SmileID): enroll/verify answer 202
 * with a job handle instead of the sync 200; the verdict arrives via
 * GET /auth/face/job/:jobId. Stub/self-held mode keeps answering sync 200.
 */
export interface FaceJobPending {
  participantId: string;
  kind: "enrollment" | "authentication";
  status: "pending";
  jobId: string;
  submittedAt: number;
}

/** Discriminator: a 202 body carries jobId + status "pending"; sync bodies don't. */
export function isFaceJobPending(body: unknown): body is FaceJobPending {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>).status === "pending" &&
    typeof (body as Record<string, unknown>).jobId === "string"
  );
}

/**
 * Enroll the participant's face right after KYC passes (the internal seam —
 * in dev it's open). `image` is base64 jpeg, camera-only per doctrine. In
 * async mode this resolves to the 202 job handle; the caller polls
 * awaitFaceJob for the verdict.
 */
export async function enrollFace(input: { participantId: string; role: string; image: string }): Promise<FaceEnrollResponse | FaceJobPending> {
  return authRequest<FaceEnrollResponse | FaceJobPending>("/auth/face/enroll", input);
}

export interface FaceVerifyResponse {
  participantId: string;
  verified: boolean;
  session: AuthSession;
}

/** Face sign-in: verify against the enrolled template and adopt the session. */
export async function verifyFace(input: { participantId: string; image: string }): Promise<FaceVerifyResponse | FaceJobPending> {
  const body = await authRequest<FaceVerifyResponse | FaceJobPending>("/auth/face/verify", input);
  // Sync mode (stub verifier): the session rides the 200. Async mode: the
  // session is issued at job collection — awaitFaceJob caches it.
  if (!isFaceJobPending(body)) await setSessionCache(body.session);
  return body;
}

/** One poll of an async face job. Pending is a 200; failure is a thrown 401 face-mismatch. */
export interface FaceJobPollPending {
  jobId: string;
  participantId: string;
  kind: "enrollment" | "authentication";
  status: "pending";
  completedAt: null;
}

export interface FaceJobComplete {
  jobId: string;
  participantId: string;
  kind: "enrollment" | "authentication";
  status: "complete";
  completedAt: number | null;
  /** Present for authentication jobs — issued at collection. */
  session?: AuthSession;
}

export async function pollFaceJob(jobId: string): Promise<FaceJobPollPending | FaceJobComplete> {
  return authGet<FaceJobPollPending | FaceJobComplete>(`/auth/face/job/${encodeURIComponent(jobId)}`);
}

const FACE_JOB_INTERVAL_MS = 2_000;
const FACE_JOB_TIMEOUT_MS = 60_000;

/**
 * Poll an async face job to its verdict (~2s cadence, ~60s cap). A completed
 * authentication job's session is cached here — screens just await. Failure
 * throws AuthError(401, "face-mismatch"), exactly like the sync path, so
 * screens reuse one error handler. Timeout throws AuthError(408,
 * "face-job-timeout") — honest "still verifying" never spins forever.
 */
export async function awaitFaceJob(jobId: string): Promise<FaceJobComplete> {
  const deadline = Date.now() + FACE_JOB_TIMEOUT_MS;
  for (;;) {
    const status = await pollFaceJob(jobId);
    if (status.status === "complete") {
      if (status.session) await setSessionCache(status.session);
      return status;
    }
    if (Date.now() >= deadline) {
      throw new AuthError(408, "face-job-timeout", "Verification is taking too long — check your connection and try again.");
    }
    await new Promise((resolve) => setTimeout(resolve, FACE_JOB_INTERVAL_MS));
  }
}

export interface DeviceKeyRegisterResponse {
  credentialId: string;
  [key: string]: unknown;
}

/**
 * Register this device's key after enrollment. The secret is generated once,
 * lives in SecureStore, and never leaves the device again — the server stores
 * its hash. 409 credential-exists means the server has upsert disabled and a
 * credential already exists; the caller surfaces that honestly and offers the
 * device-reset path.
 */
export async function registerDeviceKey(input: { participantId: string; deviceLabel?: string }): Promise<DeviceKeyRegisterResponse> {
  const secret = await getOrCreateDeviceSecret();
  const body = await authRequest<DeviceKeyRegisterResponse>("/auth/device-key/register", {
    participantId: input.participantId,
    credentialType: "device-key",
    secret,
    ...(input.deviceLabel ? { deviceLabel: input.deviceLabel } : {}),
  });
  await setCredentialCache({ participantId: input.participantId, credentialId: body.credentialId });
  return body;
}

export interface DeviceKeyAuthResponse {
  participantId: string;
  session: AuthSession;
  [key: string]: unknown;
}

/**
 * Device-key sign-in: cached credentialId + the SecureStore secret. Throws
 * AuthError(400, "no-credential") locally when this device never registered
 * (or the cache was reset) — same code the server uses, so screens handle
 * both paths identically.
 */
export async function authenticateDeviceKey(participantId: string): Promise<DeviceKeyAuthResponse> {
  const credential = credentialCache ?? (await loadDeviceCredential());
  const secret = await readDeviceSecret();
  if (!credential || credential.participantId !== participantId || !secret) {
    throw new AuthError(400, "no-credential", "This device has no registered key — sign in with your face or request a device reset.");
  }
  const body = await authRequest<DeviceKeyAuthResponse>("/auth/device-key/authenticate", {
    participantId,
    credentialId: credential.credentialId,
    secret,
  });
  await setSessionCache(body.session);
  return body;
}

export interface DeviceResetResponse {
  id: string;
  status: string;
}

/** Lost-device path: file a reset request; ops approves server-side. */
export async function requestDeviceReset(input: { participantId: string; reason: string }): Promise<DeviceResetResponse> {
  return authRequest<DeviceResetResponse>("/auth/device-reset", input);
}

/**
 * Dev-only placeholder capture for simulators and browsers without a camera
 * (same doctrine carve-out as the KYC dev capture): a 1×1 jpeg, base64.
 */
export const DEV_FACE_IMAGE_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";
