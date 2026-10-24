import { doTelemetry } from "../../../../infra/drizzle/schema.js";
import type { Env } from "../config/env.js";
import { createOpsDatabase, databaseConfigured } from "../ops-console/db.js";
import { jsonResponse } from "./runtime/responses.js";

const HEARTBEAT_MS = 15_000;
const MAX_CONNECTIONS = 100;
export type DoClass = "MarketDO" | "ProductDO" | "CartDO" | "RunDO" | "ParticipantDO";

interface SafeAttachment { authenticated?: boolean; role?: string; connectedAt?: number; topics?: string[]; }

/** Explicit, rate-limited live index. Never calls or emulates namespace listing. */
export class TelemetryReporter {
  private lastReport = 0;
  private lastActivity = Date.now();
  constructor(private ctx: DurableObjectState, private objectClass: DoClass) {}

  beat(env: Env, objectName: string, market?: string, force = false): void {
    this.lastActivity = Date.now();
    if (!databaseConfigured(env) || (!force && Date.now() - this.lastReport < HEARTBEAT_MS)) return;
    this.lastReport = Date.now();
    this.ctx.waitUntil(this.write(env, objectName, market).catch((error) => console.error("ops telemetry heartbeat failed", String(error))));
  }

  async snapshot(env: Env, objectName: string, market?: string): Promise<Response> {
    const alarm = await this.ctx.storage.getAlarm();
    const body = {
      objectName, instanceId: this.ctx.id.toString(), objectClass: this.objectClass, market: market ?? null,
      connectionCount: this.ctx.getWebSockets().length, connections: this.connections(),
      lastActivityAt: this.lastActivity, alarmAt: alarm, reportedAt: Date.now(),
    };
    if (databaseConfigured(env)) await this.write(env, objectName, market).catch(() => undefined);
    return jsonResponse(body);
  }

  private connections(): Array<{ authenticated: boolean; role: string | null; connectedAt: number | null; topicCount: number }> {
    return this.ctx.getWebSockets().slice(0, MAX_CONNECTIONS).map((socket) => {
      let value: SafeAttachment = {};
      try { value = (socket.deserializeAttachment() as SafeAttachment | null) ?? {}; } catch { /* closed mid-read */ }
      return {
        authenticated: value.authenticated === true,
        role: typeof value.role === "string" && ["buyer", "seller", "runner", "ops", "admin", "operator", "viewer"].includes(value.role) ? value.role : null,
        connectedAt: typeof value.connectedAt === "number" ? value.connectedAt : null,
        topicCount: Array.isArray(value.topics) ? Math.min(value.topics.length, 100) : 0,
      };
    });
  }

  private async write(env: Env, objectName: string, market?: string): Promise<void> {
    const { db, client } = createOpsDatabase(env);
    try {
      const alarm = await this.ctx.storage.getAlarm();
      const now = new Date();
      await db.insert(doTelemetry).values({
        objectName, instanceId: this.ctx.id.toString(), objectClass: this.objectClass, market: market ?? null,
        connectionCount: this.ctx.getWebSockets().length, connections: this.connections(),
        lastActivityAt: new Date(this.lastActivity), alarmAt: alarm === null ? null : new Date(alarm), reportedAt: now,
      }).onConflictDoUpdate({ target: doTelemetry.objectName, set: {
        instanceId: this.ctx.id.toString(), objectClass: this.objectClass, market: market ?? null,
        connectionCount: this.ctx.getWebSockets().length, connections: this.connections(),
        lastActivityAt: new Date(this.lastActivity), alarmAt: alarm === null ? null : new Date(alarm), reportedAt: now,
      } });
    } finally { await client.end(); }
  }
}
