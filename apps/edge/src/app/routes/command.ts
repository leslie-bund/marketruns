import { Hono } from "hono";
import type { Context } from "hono";
import type { MarketJoined, ParticipantOnboarded, ParticipantRecorded } from "@market-runs/proto";
import type { Env } from "../../config/env.js";
import { errorResponse, internalErrorGuard, jsonResponse, parseClientCommand } from "../../do/runtime/index.js";
import { participantObjectName } from "../../do/participant-do.js";
import { internalPost } from "../../do/transport.js";
import { correlationHeaders } from "../middleware/request-id.js";

/**
 * POST /command — the client wire. Every body parses as a ClientCommand and
 * routes by discriminant to the Durable Object that owns it.
 *
 * Auth flow: the participant middleware has already resolved the caller;
 * when the wire omits a buyerId, an authenticated caller's identity is
 * adopted so the durable record is attributed (ADR-0015).
 */
export function commandRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  /** participant.onboarded: registry first, then the market membership. */
  const onboard = async (c: Context<{ Bindings: Env }>, command: ParticipantOnboarded): Promise<Response> => {
    const registry = await c.env.PARTICIPANT_DO.get(
      c.env.PARTICIPANT_DO.idFromName(participantObjectName(command.participantId)),
    ).fetch(internalPost("/onboard", command, correlationHeaders(c)));
    if (!registry.ok) return registry;
    const recorded = (await registry.json()) as ParticipantRecorded;
    if (recorded.participant.kycStatus === "verified") {
      await joinMarket(c, { type: "market.joined", market: command.market, participantId: command.participantId, role: command.role });
    }
    return jsonResponse(recorded);
  };

  /** market.joined: the market's member list + the participant's markets list. */
  const joinMarket = async (c: Context<{ Bindings: Env }>, command: MarketJoined): Promise<Response> => {
    const market = await c.env.MARKET_DO.get(c.env.MARKET_DO.idFromName(command.market)).fetch(
      internalPost("/join", command, correlationHeaders(c)),
    );
    if (!market.ok) return market;
    // The participant side of the join lands on the caller's own object.
    await c.env.PARTICIPANT_DO.get(
      c.env.PARTICIPANT_DO.idFromName(participantObjectName(command.participantId)),
    ).fetch(internalPost("/join", command, correlationHeaders(c)));
    return market;
  };

  app.post("/", async (c) => {
    const parsed = await parseClientCommand(c.req.raw);
    if (!parsed.ok) return parsed.response;
    const command = parsed.command;

    const who = c.get("participant");
    if (
      who.source === "header" &&
      (command.type === "intent.posted" || command.type === "checkout.requested") &&
      command.buyerId === undefined
    ) {
      command.buyerId = who.id;
    }

    switch (command.type) {
      case "intent.posted":
        return c.env.MARKET_DO.get(c.env.MARKET_DO.idFromName(command.market)).fetch(
          internalPost("/intent", command, correlationHeaders(c)),
        );
      case "store.registered":
        return c.env.MARKET_DO.get(c.env.MARKET_DO.idFromName(command.market)).fetch(
          internalPost("/store", command, correlationHeaders(c)),
        );
      case "participant.onboarded":
        // Onboarding joins the participant's first market in the same move:
        // the registry records the participant, the market records the member.
        return internalErrorGuard(() => onboard(c, command));
      case "market.joined":
        return internalErrorGuard(() => joinMarket(c, command));
      case "negotiation.price-adjusted":
        return c.env.PRODUCT_DO.get(c.env.PRODUCT_DO.idFromName(command.productId)).fetch(
          internalPost("/price", command, correlationHeaders(c)),
        );
      case "product.accepted":
        // The product.accepted wire shape carries no buyerId (proto gap), so
        // the header-resolved identity rides as an internal header — the same
        // out-of-band pattern as x-market-id on config writes (ADR-0015). The
        // ProductDO keys the buyer's cart from it.
        return c.env.PRODUCT_DO.get(c.env.PRODUCT_DO.idFromName(command.productId)).fetch(
          internalPost(
            "/accept",
            command,
            correlationHeaders(c, who.source === "header" ? { "x-participant-id": who.id } : undefined),
          ),
        );
      case "checkout.requested":
        return c.env.CART_DO.get(c.env.CART_DO.idFromName(command.cartId)).fetch(
          internalPost("/checkout", command, correlationHeaders(c)),
        );
      case "handoff.challenge-scanned":
        return c.env.RUN_DO.get(c.env.RUN_DO.idFromName(command.runId)).fetch(
          internalPost("/handoff/scan", command, correlationHeaders(c)),
        );
      case "run.location-updated":
        return c.env.RUN_DO.get(c.env.RUN_DO.idFromName(command.runId)).fetch(
          internalPost("/location", command, correlationHeaders(c)),
        );
      case "handoff.photo-captured": {
        // The command carries no runId (proto gap) so it cannot self-route:
        // address it to /runs/:runId/handoffs/:handoffId/photo instead.
        return errorResponse(
          400,
          "unroutable-command",
          "handoff.photo-captured has no runId; POST it to /runs/:runId/handoffs/:handoffId/photo",
        );
      }
    }
  });

  return app;
}
