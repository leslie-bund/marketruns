import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, magicLink } from "better-auth/plugins";
import type { Context, MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { opsAudit, opsUsers } from "../../../../infra/drizzle/schema.js";
import type { Env } from "../config/env.js";
import { createOpsDatabase, databaseConfigured, opsAuthSchema, type OpsDatabase } from "./db.js";
import { sendOpsMagicLinkEmail } from "./mailer.js";

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
    database: drizzleAdapter(db, { provider: "pg", schema: opsAuthSchema }),
    emailAndPassword: { enabled: true, disableSignUp: options.bootstrap !== true, minPasswordLength: 12 },
    plugins: [
      admin({ defaultRole: "viewer", adminRoles: ["admin"] }),
      magicLink({
        expiresIn: 10 * 60,
        disableSignUp: true,
        sendMagicLink: async ({ email, url }) => {
          // Silent suppression prevents the response becoming an operator-directory oracle.
          const [user] = await db.select({ id: opsUsers.id }).from(opsUsers)
            .where(eq(opsUsers.email, email.trim().toLowerCase())).limit(1);
          if (!user) return;
          await sendOpsMagicLinkEmail(env, email, url);
        },
      }),
    ],
    user: {
      additionalFields: {
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
      if (!session) return c.json({ error: "unauthenticated", message: "sign in through the dedicated ops dashboard" }, 401);
      const user = session.user as typeof session.user & { role?: string; mustChangePassword?: boolean };
      if (user.role !== "viewer" && user.role !== "operator" && user.role !== "admin") {
        return c.json({ error: "forbidden", message: "operator role is not recognised" }, 403);
      }
      c.set("opsIdentity", {
        id: user.id, email: user.email, name: user.name, role: user.role,
        // A redeemed magic link proves email ownership and supersedes the bootstrap-password gate.
        mustChangePassword: user.mustChangePassword === true && user.emailVerified !== true,
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

const opsRole = z.enum(["viewer", "operator", "admin"]);
const adminMutationSchemas = {
  "/ops/auth/admin/create-user": z.object({ email: z.string().email(), name: z.string().trim().min(1).max(120), role: opsRole }).strict(),
  "/ops/auth/admin/set-role": z.object({ userId: z.string().min(1), role: opsRole }).strict(),
  "/ops/auth/admin/revoke-user-sessions": z.object({ userId: z.string().min(1) }).strict(),
};
type AdminMutationPath = keyof typeof adminMutationSchemas;

/** Only sign-in/session endpoints and the explicit Better Auth admin surface are exposed. */
export async function handleOpsAuth(c: Context<{ Bindings: Env }>): Promise<Response> {
  const path = new URL(c.req.url).pathname;
  const allowed = [
    "/ops/auth/sign-in/email",
    "/ops/auth/sign-in/magic-link",
    "/ops/auth/magic-link/verify",
    "/ops/auth/get-session",
    "/ops/auth/sign-out",
    "/ops/auth/change-password",
    "/ops/auth/admin/list-users",
    ...Object.keys(adminMutationSchemas),
  ];
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
    if (path in adminMutationSchemas) {
      const mutationPath = path as AdminMutationPath;
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      const actor = session?.user as { id: string; email: string; role?: string } | undefined;
      if (!actor) return c.json({ error: "unauthenticated" }, 401);
      if (actor.role !== "admin") return c.json({ error: "forbidden", message: "admin role required" }, 403);
      const parsed = adminMutationSchemas[mutationPath].safeParse(await c.req.raw.clone().json().catch(() => null));
      if (!parsed.success) return c.json({ error: "invalid-body", message: "operator mutation failed validation" }, 400);
      const mutation = parsed.data as { userId?: string; email?: string; role?: OpsRole };
      if (mutationPath === "/ops/auth/admin/set-role" && mutation.userId === actor.id) {
        return c.json({ error: "self-role-change", message: "another administrator must change your role" }, 409);
      }
      const response = await auth.handler(c.req.raw);
      if (response.ok) {
        const entityId = mutation.userId ?? mutation.email ?? "unknown";
        await resources.db.insert(opsAudit).values({
          id: crypto.randomUUID(), operatorId: actor.id, operatorEmail: actor.email,
          action: `ops-user.${mutationPath.slice("/ops/auth/admin/".length)}`,
          entityType: "ops-user", entityId,
          summary: `${mutationPath.slice("/ops/auth/admin/".length)} for ${entityId}`,
          requestId: c.get("requestId"), outcome: "applied",
          metadata: { ...(mutation.role ? { role: mutation.role } : {}) },
        });
      }
      return response;
    }
    const response = await auth.handler(c.req.raw);
    if (path !== "/ops/auth/get-session" || !response.ok) return response;
    const session = await response.clone().json().catch(() => null) as {
      user?: { emailVerified?: boolean; mustChangePassword?: boolean };
    } | null;
    if (!session?.user) return response;
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify({
      ...session,
      user: {
        ...session.user,
        mustChangePassword: session.user.mustChangePassword === true && session.user.emailVerified !== true,
      },
    }), { status: response.status, statusText: response.statusText, headers });
  } finally {
    await resources.client.end();
  }
}
