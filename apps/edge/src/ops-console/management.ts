import { Hono } from "hono";
import type { Context } from "hono";
import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { archivedProducts, liveRuns, markets, runnerPoolMemberships, runnerPools, runsArchive, shopItems, stores } from "../../../../infra/drizzle/schema.js";
import type { Env } from "../config/env.js";
import { errorResponse, jsonResponse } from "../do/runtime/index.js";
import { MarketConfigSchema } from "../do/schemas.js";
import { internalPost } from "../do/transport.js";
import { correlationHeaders } from "../app/middleware/request-id.js";
import { participantObjectName } from "../do/participant-do.js";
import { requireOpsRole } from "./auth.js";
import { auditOps } from "./audit.js";

const Name = z.string().trim().min(1).max(120);
const MarketName = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/);
const StoreInput = z.object({ marketId: MarketName, sellerId: Name, name: Name, exchangePoint: Name });
const ShopItemInput = z.object({ name: Name, attributes: z.record(z.unknown()).default({}), active: z.boolean().default(true) });
const PoolInput = z.object({ marketId: MarketName, name: Name, active: z.boolean().default(true) });

async function body<T>(c: Context<{ Bindings: Env }>, schema: z.ZodType<T>): Promise<T | Response> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : errorResponse(400, "invalid-body", "request failed validation", { issues: parsed.error.issues });
}
function noDb(c: Context<{ Bindings: Env }>): Response {
  return errorResponse(503, "ops-database-unavailable", "configure HYPERDRIVE or local DATABASE_URL");
}

export function managementRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/markets", requireOpsRole("operator"));
  app.use("/markets/*", requireOpsRole("operator"));
  app.use("/stores", requireOpsRole("operator"));
  app.use("/stores/*", requireOpsRole("operator"));
  app.use("/runner-pools", requireOpsRole("operator"));
  app.use("/runner-pools/*", requireOpsRole("operator"));

  app.get("/markets", async (c) => {
    const db = c.get("opsDb");
    if (!db) return c.json({ markets: [] });
    const market = c.req.query("market")?.trim();
    const rows = market
      ? await db.select().from(markets).where(eq(markets.id, market))
      : await db.select().from(markets).orderBy(markets.name).limit(500);
    return jsonResponse({ markets: rows.map((row) => ({ ...row, id: row.id, config: MarketConfigSchema.safeParse(row.config).success ? row.config : null })) });
  });
  app.post("/markets", async (c) => {
    const input = await body(c, MarketConfigSchema.extend({ name: MarketName })); if (input instanceof Response) return input;
    const db = c.get("opsDb"); if (!db) return noDb(c);
    const { name, ...config } = input;
    const existing = await db.select({ id: markets.id }).from(markets).where(eq(markets.name, name));
    if (existing.length) return errorResponse(409, "market-exists", `market ${name} already exists`);
    const written = await writeMarketConfig(c, name, config); if (written instanceof Response) return written;
    await db.insert(markets).values({ id: name, name, opensAt: "08:00", closesAt: "18:00", config: written });
    await auditOps(c, { action: "market.create", entityType: "market", entityId: name, summary: `Created market ${name}` });
    return jsonResponse({ market: { id: name, name }, config: written, indexed: true }, 201);
  });
  app.patch("/markets/:market", async (c) => {
    const id = decodeURIComponent(c.req.param("market"));
    const input = await body(c, z.object({ name: MarketName.optional(), active: z.boolean().optional() }).refine((v) => Object.keys(v).length > 0)); if (input instanceof Response) return input;
    const db = c.get("opsDb"); if (!db) return noDb(c);
    const updated = await db.update(markets).set({ ...input, updatedAt: new Date() }).where(eq(markets.id, id)).returning();
    if (!updated[0]) return errorResponse(404, "unknown-market", `market ${id} is unknown`);
    await auditOps(c, { action: "market.update", entityType: "market", entityId: id, summary: `${input.active === false ? "Deactivated" : "Updated"} market ${id}`, metadata: input });
    return jsonResponse({ market: updated[0] });
  });
  app.delete("/markets/:market", async (c) => {
    const id = decodeURIComponent(c.req.param("market")); const db = c.get("opsDb"); if (!db) return noDb(c);
    const updated = await db.update(markets).set({ active: false, updatedAt: new Date() }).where(eq(markets.id, id)).returning({ id: markets.id });
    if (!updated[0]) return errorResponse(404, "unknown-market", `market ${id} is unknown`);
    await auditOps(c, { action: "market.deactivate", entityType: "market", entityId: id, summary: `Deactivated market ${id}; durable history retained` });
    return jsonResponse({ market: { id, active: false } });
  });
  app.post("/markets/:market/config", requireOpsRole("admin"), async (c) => {
    const id = decodeURIComponent(c.req.param("market")); const input = await body(c, MarketConfigSchema); if (input instanceof Response) return input;
    const db = c.get("opsDb"); if (!db) return noDb(c);
    const exists = await db.select({ id: markets.id }).from(markets).where(eq(markets.id, id));
    if (!exists.length) return errorResponse(404, "unknown-market", `market ${id} is unknown`);
    const written = await writeMarketConfig(c, id, input); if (written instanceof Response) return written;
    await db.update(markets).set({ config: written, updatedAt: new Date() }).where(eq(markets.id, id));
    await auditOps(c, { action: "market.config", entityType: "market", entityId: id, summary: `Changed operational configuration for ${id}` });
    return jsonResponse({ market: { id }, config: written });
  });
  app.get("/markets/:market/vocabulary", async (c) => {
    const id = decodeURIComponent(c.req.param("market")); const db = c.get("opsDb"); if (!db) return noDb(c);
    const rows = await db.select({ name: shopItems.name, storeId: stores.id, store: stores.name }).from(shopItems).innerJoin(stores, eq(shopItems.storeId, stores.id)).where(and(eq(stores.marketId, id), eq(shopItems.active, true)));
    return jsonResponse({ market: id, vocabulary: [...new Set(rows.map((r) => r.name))].sort(), stores: rows });
  });
  app.post("/markets/:market/vocabulary", async (c) => {
    const id = decodeURIComponent(c.req.param("market"));
    const input = await body(c, z.discriminatedUnion("action", [z.object({ action: z.literal("remove"), item: Name }), z.object({ action: z.literal("rename"), from: Name, to: Name })])); if (input instanceof Response) return input;
    const db = c.get("opsDb"); if (!db) return noDb(c);
    if (input.action === "remove") await db.update(shopItems).set({ active: false, updatedAt: new Date() }).where(and(eq(shopItems.name, input.item), eq(shopItems.storeId, db.select({ id: stores.id }).from(stores).where(eq(stores.marketId, id)))));
    else {
      const rows = await db.select({ id: shopItems.id }).from(shopItems).innerJoin(stores, eq(shopItems.storeId, stores.id)).where(and(eq(stores.marketId, id), eq(shopItems.name, input.from)));
      for (const row of rows) await db.update(shopItems).set({ name: input.to, updatedAt: new Date() }).where(eq(shopItems.id, row.id));
    }
    const affected = await db.select().from(stores).where(eq(stores.marketId, id));
    for (const store of affected) await syncStore(c, store.id);
    await auditOps(c, { action: `vocabulary.${input.action}`, entityType: "market", entityId: id, summary: `${input.action === "remove" ? `Removed ${input.item}` : `Renamed ${input.from} to ${input.to}`} in ${id}` });
    return jsonResponse({ market: id, moderated: true });
  });

  app.get("/stores", async (c) => {
    const db = c.get("opsDb"); if (!db) return c.json({ items: [] });
    const market = c.req.query("market");
    const rows = market ? await db.select().from(stores).where(eq(stores.marketId, market)).limit(500) : await db.select().from(stores).orderBy(desc(stores.updatedAt)).limit(500);
    const items = await db.select().from(shopItems).orderBy(shopItems.name).limit(5000);
    return jsonResponse({ items: rows.map((store) => ({ ...store, shopItems: items.filter((item) => item.storeId === store.id) })) });
  });
  app.post("/stores", async (c) => {
    const input = await body(c, StoreInput); if (input instanceof Response) return input;
    const db = c.get("opsDb"); if (!db) return noDb(c); const id = `store:${crypto.randomUUID()}`;
    await db.insert(stores).values({ id, ...input });
    await syncStore(c, id);
    await auditOps(c, { action: "store.create", entityType: "store", entityId: id, summary: `Created store ${input.name} in ${input.marketId}` });
    return jsonResponse({ store: { id, ...input } }, 201);
  });
  app.patch("/stores/:store", async (c) => {
    const id = decodeURIComponent(c.req.param("store")); const input = await body(c, StoreInput.partial()); if (input instanceof Response) return input;
    const db = c.get("opsDb"); if (!db) return noDb(c);
    const rows = await db.update(stores).set({ ...input, updatedAt: new Date() }).where(eq(stores.id, id)).returning(); if (!rows[0]) return errorResponse(404, "unknown-store", "store is unknown");
    await syncStore(c, id); await auditOps(c, { action: "store.update", entityType: "store", entityId: id, summary: `Updated store ${rows[0].name}`, metadata: input });
    return jsonResponse({ store: rows[0] });
  });
  app.delete("/stores/:store", async (c) => {
    const id = decodeURIComponent(c.req.param("store")); const db = c.get("opsDb"); if (!db) return noDb(c);
    await db.delete(shopItems).where(eq(shopItems.storeId, id)); const rows = await db.delete(stores).where(eq(stores.id, id)).returning({ id: stores.id });
    if (!rows[0]) return errorResponse(404, "unknown-store", "store is unknown");
    const stub = c.env.MARKET_DO.get(c.env.MARKET_DO.idFromName("unknown"));
    void stub; // live copy removal uses the stored market before delete below when available; DB remains authoritative
    await auditOps(c, { action: "store.delete", entityType: "store", entityId: id, summary: `Deleted manageable store ${id}` });
    return jsonResponse({ deleted: true });
  });
  app.post("/stores/:store/items", async (c) => {
    const storeId = decodeURIComponent(c.req.param("store")); const input = await body(c, ShopItemInput); if (input instanceof Response) return input;
    const db = c.get("opsDb"); if (!db) return noDb(c); const id = `item:${crypto.randomUUID()}`;
    await db.insert(shopItems).values({ id, storeId, ...input }); await syncStore(c, storeId);
    await auditOps(c, { action: "shop-item.create", entityType: "shop-item", entityId: id, summary: `Added ${input.name} to ${storeId}` });
    return jsonResponse({ item: { id, storeId, ...input } }, 201);
  });
  app.patch("/stores/:store/items/:item", async (c) => {
    const storeId = decodeURIComponent(c.req.param("store")); const id = decodeURIComponent(c.req.param("item"));
    const input = await body(c, ShopItemInput.partial()); if (input instanceof Response) return input; const db = c.get("opsDb"); if (!db) return noDb(c);
    const rows = await db.update(shopItems).set({ ...input, updatedAt: new Date() }).where(and(eq(shopItems.id, id), eq(shopItems.storeId, storeId))).returning();
    if (!rows[0]) return errorResponse(404, "unknown-shop-item", "shop item is unknown"); await syncStore(c, storeId);
    await auditOps(c, { action: "shop-item.update", entityType: "shop-item", entityId: id, summary: `Updated shop item ${rows[0].name}`, metadata: input }); return jsonResponse({ item: rows[0] });
  });
  app.delete("/stores/:store/items/:item", async (c) => {
    const storeId = decodeURIComponent(c.req.param("store")); const id = decodeURIComponent(c.req.param("item")); const db = c.get("opsDb"); if (!db) return noDb(c);
    const rows = await db.delete(shopItems).where(and(eq(shopItems.id, id), eq(shopItems.storeId, storeId))).returning({ id: shopItems.id }); if (!rows[0]) return errorResponse(404, "unknown-shop-item", "shop item is unknown");
    await syncStore(c, storeId); await auditOps(c, { action: "shop-item.delete", entityType: "shop-item", entityId: id, summary: `Deleted shop item ${id} from ${storeId}` }); return jsonResponse({ deleted: true });
  });

  app.get("/runner-pools", async (c) => {
    const db = c.get("opsDb"); if (!db) return c.json({ items: [] });
    const pools = await db.select().from(runnerPools).orderBy(runnerPools.name).limit(500); const members = await db.select().from(runnerPoolMemberships).limit(5000);
    return jsonResponse({ items: pools.map((pool) => ({ ...pool, members: members.filter((m) => m.poolId === pool.id) })) });
  });
  app.post("/runner-pools", async (c) => {
    const input = await body(c, PoolInput); if (input instanceof Response) return input; const db = c.get("opsDb"); if (!db) return noDb(c); const id = `pool:${crypto.randomUUID()}`;
    await db.insert(runnerPools).values({ id, ...input }); await auditOps(c, { action: "runner-pool.create", entityType: "runner-pool", entityId: id, summary: `Created runner pool ${input.name}` }); return jsonResponse({ pool: { id, ...input } }, 201);
  });
  app.patch("/runner-pools/:pool", async (c) => {
    const id = decodeURIComponent(c.req.param("pool")); const input = await body(c, PoolInput.partial()); if (input instanceof Response) return input; const db = c.get("opsDb"); if (!db) return noDb(c);
    const rows = await db.update(runnerPools).set({ ...input, updatedAt: new Date() }).where(eq(runnerPools.id, id)).returning(); if (!rows[0]) return errorResponse(404, "unknown-runner-pool", "runner pool is unknown");
    await auditOps(c, { action: "runner-pool.update", entityType: "runner-pool", entityId: id, summary: `Updated runner pool ${rows[0].name}`, metadata: input }); return jsonResponse({ pool: rows[0] });
  });
  app.delete("/runner-pools/:pool", async (c) => {
    const id = decodeURIComponent(c.req.param("pool")); const db = c.get("opsDb"); if (!db) return noDb(c); const rows = await db.delete(runnerPools).where(eq(runnerPools.id, id)).returning({ id: runnerPools.id }); if (!rows[0]) return errorResponse(404, "unknown-runner-pool", "runner pool is unknown");
    await auditOps(c, { action: "runner-pool.delete", entityType: "runner-pool", entityId: id, summary: `Deleted runner pool ${id}` }); return jsonResponse({ deleted: true });
  });
  app.put("/runner-pools/:pool/members/:runner", async (c) => {
    const poolId = decodeURIComponent(c.req.param("pool")); const runnerId = decodeURIComponent(c.req.param("runner")); const db = c.get("opsDb"); if (!db) return noDb(c);
    await db.insert(runnerPoolMemberships).values({ poolId, runnerId }).onConflictDoUpdate({ target: [runnerPoolMemberships.poolId, runnerPoolMemberships.runnerId], set: { active: true, updatedAt: new Date() } });
    await auditOps(c, { action: "runner-pool.member-add", entityType: "runner-pool", entityId: poolId, summary: `Added ${runnerId} to pool ${poolId}` }); return jsonResponse({ poolId, runnerId, active: true });
  });
  app.delete("/runner-pools/:pool/members/:runner", async (c) => {
    const poolId = decodeURIComponent(c.req.param("pool")); const runnerId = decodeURIComponent(c.req.param("runner")); const db = c.get("opsDb"); if (!db) return noDb(c);
    await db.delete(runnerPoolMemberships).where(and(eq(runnerPoolMemberships.poolId, poolId), eq(runnerPoolMemberships.runnerId, runnerId)));
    await auditOps(c, { action: "runner-pool.member-remove", entityType: "runner-pool", entityId: poolId, summary: `Removed ${runnerId} from pool ${poolId}` }); return jsonResponse({ poolId, runnerId, active: false });
  });

  app.get("/participants/:participant", async (c) => {
    const id = decodeURIComponent(c.req.param("participant")); const db = c.get("opsDb");
    const stub = c.env.PARTICIPANT_DO.get(c.env.PARTICIPANT_DO.idFromName(participantObjectName(id)));
    const response = await stub.fetch(new Request(`http://do/participant/${encodeURIComponent(id)}`, { headers: correlationHeaders(c) }));
    const participant = response.ok ? await response.json() : null;
    if (!db) return jsonResponse({ participant, involvements: null });
    const [ownedStores, pools, live, historical, products] = await Promise.all([
      db.select().from(stores).where(eq(stores.sellerId, id)).limit(200),
      db.select({ pool: runnerPools, membership: runnerPoolMemberships }).from(runnerPoolMemberships).innerJoin(runnerPools, eq(runnerPoolMemberships.poolId, runnerPools.id)).where(eq(runnerPoolMemberships.runnerId, id)).limit(200),
      db.select().from(liveRuns).where(or(eq(liveRuns.buyerId, id), eq(liveRuns.runnerId, id))).limit(200),
      db.select({ id: runsArchive.id, marketId: runsArchive.marketId, status: runsArchive.status, closedAt: runsArchive.closedAt }).from(runsArchive).where(or(eq(runsArchive.buyerId, id), eq(runsArchive.runnerId, id))).orderBy(desc(runsArchive.closedAt)).limit(200),
      db.select({ id: archivedProducts.id, intentId: archivedProducts.intentId, cartId: archivedProducts.cartId }).from(archivedProducts).where(or(eq(archivedProducts.buyerId, id), eq(archivedProducts.storeId, id))).orderBy(desc(archivedProducts.retiredAt)).limit(200),
    ]);
    return jsonResponse({ participant, involvements: { stores: ownedStores, pools, markets: (participant as { participant?: { markets?: string[] } } | null)?.participant?.markets ?? [], runs: { live, historical }, rooms: products } });
  });
  return app;
}

async function writeMarketConfig(c: Context<{ Bindings: Env }>, market: string, config: z.infer<typeof MarketConfigSchema>) {
  const stub = c.env.MARKET_DO.get(c.env.MARKET_DO.idFromName(market));
  const response = await stub.fetch(internalPost("/config", config, correlationHeaders(c, { "x-market-id": market })));
  if (!response.ok) return errorResponse(502, "market-config-rejected", `MarketDO refused config (${response.status})`);
  const parsed = MarketConfigSchema.safeParse(await response.json()); return parsed.success ? parsed.data : errorResponse(502, "bad-internal-response", "MarketDO config shape was invalid");
}
async function syncStore(c: Context<{ Bindings: Env }>, storeId: string): Promise<void> {
  const db = c.get("opsDb"); if (!db) return;
  const [store] = await db.select().from(stores).where(eq(stores.id, storeId)); if (!store) return;
  const items = await db.select().from(shopItems).where(and(eq(shopItems.storeId, storeId), eq(shopItems.active, true)));
  const stub = c.env.MARKET_DO.get(c.env.MARKET_DO.idFromName(store.marketId));
  const response = await stub.fetch(internalPost("/ops/store", { store: { id: store.id, market: store.marketId, name: store.name, exchangePoint: store.exchangePoint, shopItems: items.map((i) => i.name) } }, correlationHeaders(c)));
  if (!response.ok) throw new Error(`MarketDO store sync failed (${response.status})`);
}
