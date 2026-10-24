import type { Context } from "hono";
import { desc } from "drizzle-orm";
import { opsAudit } from "../../../../infra/drizzle/schema.js";
import type { Env } from "../config/env.js";

/** One append-only, attributable record per explicit operational action. */
export async function auditOps(
  c: Context<{ Bindings: Env }>,
  entry: { action: string; entityType: string; entityId: string; summary: string; outcome?: "applied" | "rejected"; metadata?: Record<string, unknown> },
): Promise<void> {
  const identity = c.get("opsIdentity");
  const db = c.get("opsDb");
  if (!identity || !db) return; // legacy test identity has intentionally no durable audit database
  await db.insert(opsAudit).values({
    id: crypto.randomUUID(), operatorId: identity.id, operatorEmail: identity.email,
    action: entry.action, entityType: entry.entityType, entityId: entry.entityId,
    summary: entry.summary, requestId: c.get("requestId"), outcome: entry.outcome ?? "applied",
    ...(entry.metadata ? { metadata: entry.metadata } : {}),
  });
}

export async function listOpsAudit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const db = c.get("opsDb");
  if (!db) return c.json({ items: [] });
  const items = await db.select().from(opsAudit).orderBy(desc(opsAudit.createdAt)).limit(200);
  return c.json({ items });
}
