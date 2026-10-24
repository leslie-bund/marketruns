import type { Context, MiddlewareHandler } from "hono";
import { verifySessionToken } from "@market-runs/domain";
import type { Env } from "../../config/env.js";
import { errorResponse } from "../../do/runtime/index.js";
import { canTransact, coreRegistry, headerAuthAllowed } from "../../registry/index.js";

/** The single identity seam: resolved id and role are authoritative regardless of auth source. */
export type Role = "buyer" | "seller" | "runner" | "ops";

export interface Participant {
  id: string;
  role: Role;
  source: "header" | "anonymous" | "session" | "unauthenticated";
}

declare module "hono" {
  interface ContextVariableMap {
    participant: Participant;
  }
}

const ROLES: readonly string[] = ["buyer", "seller", "runner", "ops"];
const DEV_SESSION_SECRET = "market-runs-dev-session-secret";

/** Header and anonymous identities exist only in an explicit dev/test posture. */
export function resolveParticipant(c: Context<{ Bindings: Env }>): Participant {
  if (headerAuthAllowed(c.env)) {
    const id = c.req.header("x-participant-id");
    const role = c.req.header("x-participant-role");
    if (id && role && ROLES.includes(role)) return { id, role: role as Role, source: "header" };
    if (id) return { id, role: "buyer", source: "header" };
    return { id: "anonymous", role: "buyer", source: "anonymous" };
  }
  return { id: "unauthenticated", role: "buyer", source: "unauthenticated" };
}

/** Invalid or expired Bearer credentials never fall through to another identity source. */
export async function resolveParticipantWithSession(c: Context<{ Bindings: Env }>): Promise<Participant> {
  const authorization = c.req.header("authorization");
  if (authorization !== undefined) {
    if (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length) throw new Error("invalid-bearer");
    const secret = c.env.IDENTITY_SESSION_SECRET ?? (headerAuthAllowed(c.env) ? DEV_SESSION_SECRET : undefined);
    if (!secret) throw new Error("invalid-bearer");
    const result = await verifySessionToken(authorization.slice("Bearer ".length), secret);
    if (!result.ok || !ROLES.includes(result.payload.role)) throw new Error("invalid-bearer");
    return { id: result.payload.participantId, role: result.payload.role as Role, source: "session" };
  }
  return resolveParticipant(c);
}

export function participant(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    try {
      c.set("participant", await resolveParticipantWithSession(c));
    } catch {
      return errorResponse(401, "unauthorized", "a valid Bearer session is required");
    }
    await next();
  };
}

/** Verified/preverified durable profile gate for every authenticated transaction. */
export async function requireTransactionRole(
  c: Context<{ Bindings: Env }>,
  role: "buyer" | "seller" | "runner",
): Promise<Response | null> {
  const who = c.get("participant");
  if (who.source === "anonymous" && headerAuthAllowed(c.env)) return null;
  if (who.role !== role) return errorResponse(403, "forbidden", `this transaction requires the ${role} role`);
  if (who.source === "unauthenticated") return errorResponse(401, "unauthorized", "a Bearer session is required");
  if (who.source !== "session") {
    return headerAuthAllowed(c.env) ? null : errorResponse(401, "unauthorized", "a Bearer session is required");
  }
  const profile = await coreRegistry(c.env).participant(who.id);
  if (!profile || profile.role !== role) return errorResponse(403, "forbidden", "the session does not match the durable participant profile");
  if (!canTransact(profile.kycStatus)) {
    return errorResponse(403, "kyc-required", "verified KYC is required before transacting");
  }
  return null;
}

/** @deprecated Legacy development guard; deployed ops uses Better Auth. */
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
