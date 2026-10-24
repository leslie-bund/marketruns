import { Hono } from "hono";
import type { Context } from "hono";
import type { MarketJoined, ParticipantOnboarded, ParticipantRecorded } from "@market-runs/proto";
import type { Env } from "../../config/env.js";
import { errorResponse, internalErrorGuard, jsonResponse, parseClientCommand } from "../../do/runtime/index.js";
import { participantObjectName } from "../../do/participant-do.js";
import { internalPost } from "../../do/transport.js";
import { correlationHeaders } from "../middleware/request-id.js";
import { requireTransactionRole } from "../middleware/participant.js";
import { canTransact, coreRegistry } from "../../registry/index.js";

function identityHeaders(c: Context<{ Bindings: Env }>): Record<string, string> {
  const who = c.get("participant");
  return {
    "x-resolved-participant-id": who.id,
    "x-resolved-participant-role": who.role,
    "x-resolved-participant-source": who.source,
  };
}

async function knownMarket(c: Context<{ Bindings: Env }>, market: string): Promise<boolean> {
  if (c.get("participant").source !== "session") return true; // legacy dev fixtures create ad-hoc zones
  const markets = await coreRegistry(c.env).listMarkets();
  return markets.some((entry) => entry.id.toLowerCase() === market.toLowerCase());
}

/** POST /command: client wire validation, resolved-identity attribution, then DO routing. */
export function commandRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  const onboard = async (c: Context<{ Bindings: Env }>, command: ParticipantOnboarded): Promise<Response> => {
    const who = c.get("participant");
    if (who.source === "unauthenticated") return errorResponse(401, "unauthorized", "a Bearer session is required");
    if (who.source === "session") {
      if (command.participantId !== who.id || command.role !== who.role) {
        return errorResponse(403, "forbidden", "onboarding identity and role must match the Bearer session");
      }
      if (!command.email || !command.consentAt || !command.consentVersion) {
        return errorResponse(400, "invalid-body", "authenticated onboarding requires email, consentAt, and consentVersion");
      }
    }
    if (!(await knownMarket(c, command.market))) return errorResponse(404, "unknown-market", `market ${command.market} is not registered`);
    const registry = await c.env.PARTICIPANT_DO.get(
      c.env.PARTICIPANT_DO.idFromName(participantObjectName(command.participantId)),
    ).fetch(internalPost("/onboard", command, correlationHeaders(c)));
    if (!registry.ok) return registry;
    const recorded = (await registry.json()) as ParticipantRecorded;
    await coreRegistry(c.env).saveParticipant(recorded.participant);
    if (canTransact(recorded.participant.kycStatus)) {
      const joined = await joinMarket(c, {
        type: "market.joined",
        market: command.market,
        participantId: command.participantId,
        role: command.role,
      });
      if (!joined.ok) return joined;
    }
    return jsonResponse(recorded);
  };

  const joinMarket = async (c: Context<{ Bindings: Env }>, command: MarketJoined): Promise<Response> => {
    if (!(await knownMarket(c, command.market))) return errorResponse(404, "unknown-market", `market ${command.market} is not registered`);
    const market = await c.env.MARKET_DO.get(c.env.MARKET_DO.idFromName(command.market)).fetch(
      internalPost("/join", command, correlationHeaders(c)),
    );
    if (!market.ok) return market;
    await c.env.PARTICIPANT_DO.get(
      c.env.PARTICIPANT_DO.idFromName(participantObjectName(command.participantId)),
    ).fetch(internalPost("/join", command, correlationHeaders(c)));
    if (command.role === "runner") await coreRegistry(c.env).joinInternalRunner(command.market, command.participantId);
    const profile = await coreRegistry(c.env).participant(command.participantId);
    if (profile) {
      profile.markets = [...new Set([...profile.markets, command.market])];
      await coreRegistry(c.env).saveParticipant(profile);
    }
    return market;
  };

  app.post("/", async (c) => {
    const parsed = await parseClientCommand(c.req.raw);
    if (!parsed.ok) return parsed.response;
    const command = parsed.command;
    const who = c.get("participant");

    if (command.type !== "participant.onboarded") {
      const requiredRole =
        command.type === "store.registered" ? "seller" :
        command.type === "run.location-updated" || command.type === "handoff.challenge-scanned" ? "runner" :
        command.type === "market.joined" ? who.role :
        command.type === "negotiation.price-adjusted" ? command.by : "buyer";
      if (requiredRole !== "buyer" && requiredRole !== "seller" && requiredRole !== "runner") {
        return errorResponse(403, "forbidden", "participant role cannot transact");
      }
      const denied = await requireTransactionRole(c, requiredRole);
      if (denied) return denied;
    }

    if ((command.type === "intent.posted" || command.type === "checkout.requested") && who.source !== "anonymous" && who.source !== "unauthenticated") {
      if (command.buyerId !== undefined && command.buyerId !== who.id) {
        return errorResponse(403, "forbidden", "buyerId must match the resolved caller");
      }
      command.buyerId = who.id;
    }
    if (command.type === "market.joined" && who.source !== "anonymous" && who.source !== "unauthenticated") {
      if (command.participantId !== who.id || command.role !== who.role) {
        return errorResponse(403, "forbidden", "market membership must match the resolved caller");
      }
    }
    if (command.type === "store.registered" && who.source !== "anonymous" && who.source !== "unauthenticated") {
      if (command.sellerParticipantId !== undefined && command.sellerParticipantId !== who.id) {
        return errorResponse(403, "forbidden", "store owner must match the resolved seller");
      }
      command.sellerParticipantId = who.id;
    }
    if ((command.type === "intent.posted" || command.type === "store.registered") && !(await knownMarket(c, command.market))) {
      return errorResponse(404, "unknown-market", `market ${command.market} is not registered`);
    }

    switch (command.type) {
      case "intent.posted":
        return c.env.MARKET_DO.get(c.env.MARKET_DO.idFromName(command.market)).fetch(
          internalPost("/intent", command, correlationHeaders(c, identityHeaders(c))),
        );
      case "store.registered": {
        const response = await c.env.MARKET_DO.get(c.env.MARKET_DO.idFromName(command.market)).fetch(
          internalPost("/store", command, correlationHeaders(c, identityHeaders(c))),
        );
        if (response.ok) {
          const event = (await response.clone().json()) as { store?: import("@market-runs/proto").Store };
          if (event.store) await coreRegistry(c.env).saveStore(event.store);
        }
        return response;
      }
      case "participant.onboarded":
        return internalErrorGuard(() => onboard(c, command));
      case "market.joined":
        return internalErrorGuard(() => joinMarket(c, command));
      case "negotiation.price-adjusted":
        return c.env.PRODUCT_DO.get(c.env.PRODUCT_DO.idFromName(command.productId)).fetch(
          internalPost("/price", command, correlationHeaders(c, identityHeaders(c))),
        );
      case "product.accepted":
        return c.env.PRODUCT_DO.get(c.env.PRODUCT_DO.idFromName(command.productId)).fetch(
          internalPost("/accept", command, correlationHeaders(c, { ...(who.source === "anonymous" ? {} : { "x-participant-id": who.id }), ...identityHeaders(c) })),
        );
      case "checkout.requested":
        return c.env.CART_DO.get(c.env.CART_DO.idFromName(command.cartId)).fetch(
          internalPost("/checkout", command, correlationHeaders(c, identityHeaders(c))),
        );
      case "handoff.challenge-scanned":
        return c.env.RUN_DO.get(c.env.RUN_DO.idFromName(command.runId)).fetch(
          internalPost("/handoff/scan", command, correlationHeaders(c, identityHeaders(c))),
        );
      case "run.location-updated":
        return c.env.RUN_DO.get(c.env.RUN_DO.idFromName(command.runId)).fetch(
          internalPost("/location", command, correlationHeaders(c, identityHeaders(c))),
        );
      case "handoff.photo-captured":
        return errorResponse(400, "unroutable-command", "handoff.photo-captured has no runId; POST it to /runs/:runId/handoffs/:handoffId/photo");
    }
  });

  return app;
}
