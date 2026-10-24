import type { Context, MiddlewareHandler } from "hono";
import { verifySessionToken } from "@market-runs/domain";
import type { Env } from "../../config/env.js";

/**
 * The authentication/authorisation seam (ADR-0015).
 *
 * Today the wire carries no auth at all — identities are optional
 * client-supplied strings. This middleware is the single place where
 * identity enters the request context; when real authentication lands
 * (better-auth, a session service, or vendor KYC assertions — ADR-0004/0009),
 * ONLY `resolveParticipant` changes. Role guards read the resolved
 * participant, so every route's auth requirement stays one line and visible.
 *
 * Dev-stage resolution order:
 *   1. `Authorization: Bearer <session>` — a session token issued by the
 *      identity worker (apps/identity) after face/device-key login, verified
 *      LOCALLY via HMAC with the shared secret (no per-request round trip to
 *      the identity worker — revocation-sensitive checks call
 *      /auth/session/validate instead). Resolves with source "session";
 *   2. `x-participant-id` / `x-participant-role` headers (a signed-in client
 *      proxy would set these after verifying its own session);
 *   3. anonymous participant (client wire unchanged).
 *
 * A present-but-invalid Bearer token falls through to the header/anonymous
 * modes rather than 401-ing — the same fail-open posture as the rest of the
 * dev-stage seam; tightening that is part of the real-auth integration step.
 */

export type Role = "buyer" | "seller" | "runner" | "ops";

export interface Participant {
  id: string;
  role: Role;
  /** Where this identity came from — makes the auth flow observable. */
  source: "header" | "anonymous" | "session";
}

declare module "hono" {
  interface ContextVariableMap {
    participant: Participant;
  }
}

const ROLES: readonly string[] = ["buyer", "seller", "runner", "ops"];

/**
 * Session secret is declared LOCALLY (config/env.ts belongs to the later
 * integration step). Dev default matches apps/identity's so a token minted
 * by the dev identity worker verifies here out of the box; deploys set
 * IDENTITY_SESSION_SECRET via wrangler secret on BOTH workers.
 */
type SessionEnv = { IDENTITY_SESSION_SECRET?: string };
const DEV_SESSION_SECRET = "market-runs-dev-session-secret";

export function resolveParticipant(c: Context<{ Bindings: Env }>): Participant {
  const id = c.req.header("x-participant-id");
  const role = c.req.header("x-participant-role");
  if (id && role && ROLES.includes(role)) return { id, role: role as Role, source: "header" };
  if (id) return { id, role: "buyer", source: "header" };
  return { id: "anonymous", role: "buyer", source: "anonymous" };
}

/** Async resolver: verifies a Bearer session token locally, else dev header mode. */
export async function resolveParticipantWithSession(c: Context<{ Bindings: Env }>): Promise<Participant> {
  const authorization = c.req.header("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const secret = (c.env as Env & SessionEnv).IDENTITY_SESSION_SECRET ?? DEV_SESSION_SECRET;
    const result = await verifySessionToken(authorization.slice("Bearer ".length), secret);
    if (result.ok && ROLES.includes(result.payload.role)) {
      return { id: result.payload.participantId, role: result.payload.role as Role, source: "session" };
    }
  }
  return resolveParticipant(c);
}

/** Resolve the caller's participant identity onto the context. */
export function participant(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    c.set("participant", await resolveParticipantWithSession(c));
    await next();
  };
}

// Ops authentication intentionally does not live in this participant seam.
// See ops-console/auth.ts: Better Auth protects OPS ONLY.

/** @deprecated Legacy development guard retained for old direct-route tests. */
export function requireOps(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const token = c.env.OPS_TOKEN;
    if (token) {
      if (c.req.header("x-ops-token") !== token) {
        return c.json({ error: "forbidden", message: "a valid x-ops-token is required for ops adjustments" }, 403);
      }
      c.set("participant", { id: "ops", role: "ops", source: "header" });
    } else {
      const resolved = resolveParticipant(c);
      c.set("participant", resolved.role === "ops" ? resolved : { id: "local-ops", role: "ops", source: "anonymous" });
    }
    await next();
  };
}
