import { z } from "zod";
import { Hono } from "hono";
import type { Context } from "hono";
import { StoreSchema } from "@market-runs/proto";
import type { Env } from "../config/env.js";
import { addMarketToIndex, isKnownMarket, listMarketIds, syncMarketGeofence } from "../config/markets.js";
import { errorResponse, jsonResponse } from "../do/runtime/index.js";
import { MarketConfigSchema, ModerateVocabularyRequestSchema, ModerateVocabularyResponseSchema } from "../do/schemas.js";
import { internalPost } from "../do/transport.js";
import { correlationHeaders } from "../app/middleware/request-id.js";

/**
 * Zone admin for the ops console (pulled forward from the ADR-0016 v2
 * deferral): list zones with their live MarketDO config, create a zone, and
 * tune a zone's timer values. The v1 timer *structure* is doctrine — the
 * config body is exactly the MarketDO's own MarketConfigSchema, so only
 * values the DO already supports are exposed.
 *
 * Mounted at /ops/api, behind the requireOps guard.
 */

/** Zone names are display names (GLOSSARY: Balogun, Computer Village), not slugs — but stay URL-safe-ish. */
const MarketNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, "market names use letters, digits, spaces, '.', '_' or '-' and start alphanumeric");

/** Create body: the zone name plus exactly the config the MarketDO config write accepts. */
const CreateMarketRequestSchema = MarketConfigSchema.extend({ name: MarketNameSchema });

export function marketsAdminRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  /** Every known zone with its live config merged in (null when the DO cannot be read). */
  app.get("/markets", async (c) => {
    const ids = await listMarketIds(c.env);
    const markets = await Promise.all(ids.map((id) => readMarketConfig(c, id)));
    return jsonResponse({ markets });
  });

  /** Create a zone: initialize the MarketDO config, then index it in KV. */
  app.post("/markets", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return errorResponse(400, "invalid-body", "request body is not valid JSON");
    }
    const parsed = CreateMarketRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return errorResponse(400, "invalid-body", "request body failed market validation", { issues: parsed.error.issues });
    }
    const { name, ...config } = parsed.data;

    const ids = await listMarketIds(c.env);
    if (isKnownMarket(ids, name)) {
      return errorResponse(409, "market-exists", `market ${name} already exists`);
    }

    const written = await writeMarketConfig(c, name, config);
    if (written instanceof Response) return written;

    // The index heals on next join even when this put fails — report, don't 500.
    const indexed = await addMarketToIndex(c.env, name, written);
    return jsonResponse({ market: { id: name }, config: written, indexed }, 201);
  });

  /** Tune a zone's timer/settlement/geofence values: new actions read the live config. */
  app.post("/markets/:market/config", async (c) => {
    const market = decodeURIComponent(c.req.param("market"));
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return errorResponse(400, "invalid-body", "request body is not valid JSON");
    }
    const parsed = MarketConfigSchema.safeParse(raw);
    if (!parsed.success) {
      return errorResponse(400, "invalid-body", "request body failed config validation", { issues: parsed.error.issues });
    }
    const ids = await listMarketIds(c.env);
    if (!isKnownMarket(ids, market)) {
      return errorResponse(404, "unknown-market", `market ${market} is not a known zone`);
    }
    const written = await writeMarketConfig(c, market, parsed.data);
    if (written instanceof Response) return written;
    await syncMarketGeofence(c.env, market, written);
    return jsonResponse({ market: { id: market }, config: written });
  });

  /**
   * Vocabulary moderation (ADR-0006 — the platform curates normalization and
   * synonyms, not a canon). GET gives the per-store breakdown moderation
   * needs (which store lists which items); POST forwards a validated
   * remove/rename to the MarketDO's own write path.
   */
  app.get("/markets/:market/vocabulary", async (c) => {
    const market = decodeURIComponent(c.req.param("market"));
    const ids = await listMarketIds(c.env);
    const known = isKnownMarket(ids, market);
    const stub = c.env.MARKET_DO.get(c.env.MARKET_DO.idFromName(market));
    const response = await stub.fetch(new Request("http://do/stores", { headers: correlationHeaders(c) }));
    if (!response.ok) {
      return errorResponse(502, "market-stores-unreadable", `MarketDO refused the stores read (${response.status})`);
    }
    const parsed = z.object({ stores: z.array(StoreSchema) }).safeParse(await response.json());
    if (!parsed.success) {
      return errorResponse(502, "bad-internal-response", "MarketDO stores read returned an unexpected shape", {
        issues: parsed.error.issues,
      });
    }
    if (!known && parsed.data.stores.length === 0) {
      return errorResponse(404, "unknown-market", `market ${market} is not a known zone`);
    }
    const stores = parsed.data.stores.map((store) => ({ id: store.id, name: store.name, shopItems: store.shopItems }));
    const vocabulary = [...new Set(stores.flatMap((store) => store.shopItems))].sort((a, b) => a.localeCompare(b));
    return jsonResponse({ market, vocabulary, stores });
  });

  app.post("/markets/:market/vocabulary", async (c) => {
    const market = decodeURIComponent(c.req.param("market"));
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return errorResponse(400, "invalid-body", "request body is not valid JSON");
    }
    const parsed = ModerateVocabularyRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return errorResponse(400, "invalid-body", "request body failed vocabulary-moderation validation", {
        issues: parsed.error.issues,
      });
    }
    const ids = await listMarketIds(c.env);
    if (!isKnownMarket(ids, market)) {
      return errorResponse(404, "unknown-market", `market ${market} is not a known zone`);
    }
    const stub = c.env.MARKET_DO.get(c.env.MARKET_DO.idFromName(market));
    const response = await stub.fetch(internalPost("/moderate-vocabulary", parsed.data, correlationHeaders(c)));
    if (!response.ok) {
      return errorResponse(502, "market-moderation-rejected", `MarketDO refused the moderation write (${response.status})`, {
        detail: await response.text(),
      });
    }
    const moderated = ModerateVocabularyResponseSchema.safeParse(await response.json());
    if (!moderated.success) {
      return errorResponse(502, "bad-internal-response", "MarketDO moderation write returned an unexpected shape", {
        issues: moderated.error.issues,
      });
    }
    return jsonResponse({ market, ...moderated.data });
  });

  return app;
}

interface MarketWithConfig {
  id: string;
  config: z.infer<typeof MarketConfigSchema> | null;
}

/** A zone's effective config — the MarketDO serves defaults even when never touched. */
async function readMarketConfig(c: Context<{ Bindings: Env }>, id: string): Promise<MarketWithConfig> {
  try {
    const stub = c.env.MARKET_DO.get(c.env.MARKET_DO.idFromName(id));
    const response = await stub.fetch(new Request("http://do/config", { headers: correlationHeaders(c) }));
    if (!response.ok) return { id, config: null };
    const parsed = MarketConfigSchema.safeParse(await response.json());
    return { id, config: parsed.success ? parsed.data : null };
  } catch {
    return { id, config: null };
  }
}

/** Write a zone's config through the MarketDO's own validated write path. */
async function writeMarketConfig(
  c: Context<{ Bindings: Env }>,
  market: string,
  config: z.infer<typeof MarketConfigSchema>,
): Promise<z.infer<typeof MarketConfigSchema> | Response> {
  const stub = c.env.MARKET_DO.get(c.env.MARKET_DO.idFromName(market));
  const response = await stub.fetch(internalPost("/config", config, correlationHeaders(c, { "x-market-id": market })));
  if (!response.ok) {
    return errorResponse(502, "market-config-rejected", `MarketDO refused the config write (${response.status})`, {
      detail: await response.text(),
    });
  }
  const parsed = MarketConfigSchema.safeParse(await response.json());
  if (!parsed.success) {
    return errorResponse(502, "bad-internal-response", "MarketDO config write returned an unexpected shape", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}
