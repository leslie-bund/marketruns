import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Context, MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { opsUsers } from "../../../../infra/drizzle/schema.js";
import type { Env } from "../config/env.js";
import { createOpsDatabase, databaseConfigured, type OpsDatabase } from "./db.js";

export type OpsRole = "viewer" | "operator" | "admin";
export interface OpsIdentity { id: string; email: string; name: string; role: OpsRole; mustChangePassword: boolean; }

type Auth = ReturnType<typeof createOpsAuth>;

declare module "hono" {
  interface ContextVariableMap {
    opsIdentity: OpsIdentity;
    opsDb: OpsDatabase;
    opsAuth: Auth;
  }
}

/** Better Auth is deliberately scoped to /ops/auth; participants never enter it. */
export function createOpsAuth(env: Env, db: OpsDatabase, options: { bootstrap?: boolean } = {}) {
  if (!env.OPS_AUTH_SECRET || env.OPS_AUTH_SECRET.length < 32) {
    throw new Error("OPS_AUTH_SECRET must be a random secret of at least 32 characters");
  }
  return betterAuth({
    appName: "Market Runs Ops",
    baseURL: env.OPS_BASE_URL,
    basePath: "/ops/auth",
    secret: env.OPS_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "pg" }),
    emailAndPassword: { enabled: true, disableSignUp: options.bootstrap !== true, minPasswordLength: 12 },
    user: {
      additionalFields: {
        role: { type: "string", required: true, defaultValue: "viewer", input: false },
        mustChangePassword: { type: "boolean", required: true, defaultValue: true, input: false },
      },
    },
    session: { expiresIn: 8 * 60 * 60, updateAge: 30 * 60, cookieCache: { enabled: false } },
    advanced: { useSecureCookies: !env.OPS_LOCAL_DEV },
  });
}

function legacyIdentity(env: Env): OpsIdentity | null {
  // Explicitly for automated/local tests only. Never inferred from a missing secret.
  if (env.OPS_LEGACY_DEV !== "true" || env.OPS_LOCAL_DEV !== "true") return null;
  return { id: "local-ops", email: "local-ops@localhost", name: "Local ops", role: "admin", mustChangePassword: false };
}

export function withOpsAuth(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const legacy = legacyIdentity(c.env);
    if (legacy) {
      const legacyToken = c.req.header("x-ops-token") ?? c.req.query("token");
      if (c.env.OPS_TOKEN && legacyToken !== c.env.OPS_TOKEN) {
        if (!new URL(c.req.url).pathname.includes("/api/")) {
          return new Response("<h1>403 — legacy ops token required</h1>", { status: 403, headers: { "content-type": "text/html; charset=utf-8" } });
        }
        return c.json({ error: "forbidden", message: "a valid x-ops-token is required in legacy dev mode" }, 403);
      }
      c.set("opsIdentity", legacy); await next(); return;
    }
    if (!databaseConfigured(c.env)) return c.json({ error: "ops-auth-unavailable", message: "configure HYPERDRIVE and OPS_AUTH_SECRET" }, 503);
    let resources: ReturnType<typeof createOpsDatabase> | undefined;
    try {
      resources = createOpsDatabase(c.env);
      const auth = createOpsAuth(c.env, resources.db);
      c.set("opsDb", resources.db);
      c.set("opsAuth", auth);
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) return c.json({ error: "unauthenticated", message: "sign in at /ops/login" }, 401);
      const user = session.user as typeof session.user & { role?: string; mustChangePassword?: boolean };
      if (user.role !== "viewer" && user.role !== "operator" && user.role !== "admin") {
        return c.json({ error: "forbidden", message: "operator role is not recognised" }, 403);
      }
      c.set("opsIdentity", {
        id: user.id, email: user.email, name: user.name, role: user.role,
        mustChangePassword: user.mustChangePassword === true,
      });
      await next();
    } catch (error) {
      if (c.finalized) throw error;
      return c.json({ error: "ops-auth-unavailable", message: error instanceof Error ? error.message : String(error) }, 503);
    } finally {
      if (resources) await resources.client.end();
    }
  };
}

export function requireOpsRole(minimum: Exclude<OpsRole, "viewer"> = "operator"): MiddlewareHandler<{ Bindings: Env }> {
  const rank: Record<OpsRole, number> = { viewer: 0, operator: 1, admin: 2 };
  return async (c, next) => {
    const identity = c.get("opsIdentity");
    if (!identity) return c.json({ error: "unauthenticated" }, 401);
    if (identity.mustChangePassword) return c.json({ error: "password-change-required", message: "change the bootstrap password before using ops" }, 403);
    if (rank[identity.role] < rank[minimum]) return c.json({ error: "forbidden", message: `${minimum} role required` }, 403);
    await next();
  };
}

/** Auth endpoints are public, but only sign-in/session/sign-out/change-password are exposed. */
export async function handleOpsAuth(c: Context<{ Bindings: Env }>): Promise<Response> {
  const path = new URL(c.req.url).pathname;
  const allowed = ["/ops/auth/sign-in/email", "/ops/auth/get-session", "/ops/auth/sign-out", "/ops/auth/change-password"];
  if (!allowed.includes(path)) return c.json({ error: "not-found" }, 404);
  if (!databaseConfigured(c.env)) return c.json({ error: "ops-auth-unavailable" }, 503);
  const resources = createOpsDatabase(c.env);
  try {
    const auth = createOpsAuth(c.env, resources.db);
    if (path === "/ops/auth/change-password") {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) return c.json({ error: "unauthenticated" }, 401);
      const response = await auth.handler(c.req.raw);
      if (response.ok) await resources.db.update(opsUsers).set({ mustChangePassword: false, updatedAt: new Date() }).where(eq(opsUsers.id, session.user.id));
      return response;
    }
    return await auth.handler(c.req.raw);
  } finally {
    await resources.client.end();
  }
}
