import { Hono } from "hono";
import type { Context } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { doTelemetry } from "../../../../infra/drizzle/schema.js";
import type { Env } from "../config/env.js";
import { errorResponse } from "../do/runtime/index.js";
import { correlationHeaders } from "../app/middleware/request-id.js";

const classes = ["MarketDO", "ProductDO", "CartDO", "RunDO", "ParticipantDO"] as const;
type ClassName = (typeof classes)[number];

export function telemetryRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/telemetry", async (c) => {
    const db = c.get("opsDb"); if (!db) return c.json({ items: [], generatedAt: Date.now() });
    const className = c.req.query("class"); const market = c.req.query("market");
    if (className && !classes.includes(className as ClassName)) return errorResponse(400, "invalid-query", "unknown DO class");
    const predicates = [];
    if (className) predicates.push(eq(doTelemetry.objectClass, className));
    if (market) predicates.push(eq(doTelemetry.market, market));
    const rows = await db.select().from(doTelemetry).where(predicates.length ? and(...predicates) : undefined).orderBy(desc(doTelemetry.reportedAt)).limit(1000);
    const now = Date.now();
    return c.json({ generatedAt: now, items: rows.map((row) => ({ ...row, live: now - new Date(row.reportedAt).getTime() < 45_000 })) });
  });
  app.get("/telemetry/:class/:objectName", async (c) => {
    const target = await locate(c); if (target instanceof Response) return target;
    const response = await target.stub.fetch(new Request("http://do/ops/telemetry", { headers: correlationHeaders(c) }));
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
  });
  app.get("/telemetry/:class/:objectName/ws", async (c) => {
    const target = await locate(c); if (target instanceof Response) return target;
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return errorResponse(426, "websocket-required", "observer attachment requires WebSocket upgrade");
    const identity = c.get("opsIdentity");
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-ops-observer", "1"); headers.set("x-ops-role", identity.role);
    return target.stub.fetch(new Request("http://do/", { headers }));
  });
  return app;
}

async function locate(c: Context<{ Bindings: Env }>) {
  const className = c.req.param("class") as ClassName; const objectName = decodeURIComponent(c.req.param("objectName") ?? "");
  if (!classes.includes(className) || objectName.length > 512) return errorResponse(400, "invalid-telemetry-target", "invalid telemetry target");
  const db = c.get("opsDb"); if (!db) return errorResponse(503, "ops-database-unavailable", "telemetry index is unavailable");
  const [indexed] = await db.select({ objectName: doTelemetry.objectName }).from(doTelemetry).where(and(eq(doTelemetry.objectClass, className), eq(doTelemetry.objectName, objectName))).limit(1);
  if (!indexed) return errorResponse(404, "telemetry-not-indexed", "instance is not in the explicit live telemetry index");
  const env = c.env as Env;
  const namespace = env[className === "MarketDO" ? "MARKET_DO" : className === "ProductDO" ? "PRODUCT_DO" : className === "CartDO" ? "CART_DO" : className === "RunDO" ? "RUN_DO" : "PARTICIPANT_DO"];
  return { stub: namespace.get(namespace.idFromName(objectName)) };
}
