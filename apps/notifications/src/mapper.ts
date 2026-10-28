import { ServerEventSchema, type NotificationCategory, type ServerEvent } from "@market-runs/proto";
import type { NotificationDraft } from "./drafts.js";

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0 && value !== "anonymous" && value !== "buyer:anonymous" && value !== "platform"))];
}

function runLink(runId: string, recipientId: string, buyerId?: string | null, runnerId?: string | null, handoffId?: string): string {
  const run = `runId=${encodeURIComponent(runId)}`;
  const handoff = handoffId ? `&handoffId=${encodeURIComponent(handoffId)}` : "";
  if (recipientId === buyerId) return `/buyer/run?${run}${handoff}`;
  if (recipientId === runnerId) return handoffId ? `/runner/handoff?${run}${handoff}` : `/runner?${run}`;
  return `/seller/trip?${run}${handoff}`;
}

function archivedRunLink(runId: string, status: string): string {
  return `/receipt?runId=${encodeURIComponent(runId)}&status=${encodeURIComponent(status)}`;
}

function draftsFor(
  sourceEventId: string,
  occurredAt: number,
  event: ServerEvent,
  recipients: Array<string | null | undefined>,
  content: { category?: NotificationCategory; title: string; body: string; deepLink?: string; data?: Record<string, unknown>; email?: "receipt" | "security" },
  linkFor?: (recipientId: string) => string,
): NotificationDraft[] {
  return unique(recipients).map((recipientId) => ({
    sourceEventId,
    sourceEventType: event.type,
    recipientId,
    dedupeKey: `${sourceEventId}:${recipientId}`,
    category: content.category ?? "marketplace",
    title: content.title,
    body: content.body,
    ...(content.deepLink || linkFor ? { deepLink: linkFor?.(recipientId) ?? content.deepLink ?? "/notifications" } : {}),
    data: content.data ?? {},
    occurredAt,
    ...(content.email ? { email: content.email } : {}),
  }));
}

/** Resolve recipients only from trusted server event attribution. Missing parallel-work contracts skip safely. */
export function mapServerEvent(sourceEventId: string, occurredAt: number, input: unknown): NotificationDraft[] {
  const parsed = ServerEventSchema.safeParse(input);
  if (!parsed.success) throw new Error(`unsupported notification source event: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const event = parsed.data;
  switch (event.type) {
    case "participant.recorded":
      return draftsFor(sourceEventId, occurredAt, event, [event.participant.id], {
        category: "security",
        title: event.participant.kycStatus === "verified" ? "Identity verified" : "Identity verification update",
        body: event.participant.kycStatus === "verified" ? "Your identity verification passed." : `Your identity verification status is ${event.participant.kycStatus}.`,
        deepLink: "/notifications",
        data: { status: event.participant.kycStatus },
        email: "security",
      });
    case "intent.recorded":
      return draftsFor(sourceEventId, occurredAt, event, [event.intent.buyerId], {
        title: "Intent posted",
        body: `${event.intent.shopItem} is now visible to matching stores.`,
        deepLink: "/buyer",
        data: { intentId: event.intent.id },
      });
    case "intent.expired":
      return draftsFor(sourceEventId, occurredAt, event, [event.buyerId], {
        title: "Intent expired",
        body: "Your intent has expired and can no longer receive offers.",
        deepLink: "/buyer/post",
        data: { intentId: event.intentId },
      });
    case "product.offered":
      return draftsFor(sourceEventId, occurredAt, event, [event.buyerId], {
        title: "New offer received",
        body: `${event.product.sellerName} offered ${event.product.shopItem}.`,
        deepLink: `/buyer/products?intentId=${encodeURIComponent(event.product.intentId)}&productId=${encodeURIComponent(event.product.id)}`,
        data: { productId: event.product.id, intentId: event.product.intentId },
      });
    case "negotiation.price-adjusted": {
      const recipient = event.by === "seller" ? event.buyerId : event.sellerParticipantId;
      return draftsFor(sourceEventId, occurredAt, event, [recipient], {
        title: "Offer price updated",
        body: `The ${event.by} adjusted the offer price.`,
        data: { productId: event.productId },
      }, (recipientId) => recipientId === event.sellerParticipantId
        ? `/seller/negotiation?productId=${encodeURIComponent(event.productId)}`
        : `/buyer/negotiation?productId=${encodeURIComponent(event.productId)}`);
    }
    case "product.retired":
      return draftsFor(sourceEventId, occurredAt, event, [event.buyerId], {
        title: "Offer no longer available",
        body: `The offer was ${event.reason.replace("-", " ")}.`,
        deepLink: "/buyer",
        data: { productId: event.productId, intentId: event.intentId },
      });
    case "cart.updated":
      return draftsFor(sourceEventId, occurredAt, event, [event.cart.buyerId], {
        title: "Cart updated",
        body: `${event.cart.products.length} accepted ${event.cart.products.length === 1 ? "product" : "products"} in your cart.`,
        deepLink: "/buyer/cart",
        data: { cartId: event.cart.id },
      });
    case "checkout.accepted": {
      const recipients = unique([event.buyerId, event.runnerId]);
      return draftsFor(sourceEventId, occurredAt, event, recipients, {
        title: "Run assigned",
        body: "Checkout is complete and your run is ready to begin.",
        data: { cartId: event.cartId, runId: event.runId },
      }, (recipientId) => runLink(event.runId, recipientId, event.buyerId, event.runnerId));
    }
    case "cart.retired":
      return draftsFor(sourceEventId, occurredAt, event, [event.snapshot.buyerId], {
        title: event.reason === "deadline-expired" ? "Cart expired" : "Cart closed",
        body: event.reason === "deadline-expired" ? "Your cart deadline passed and its offers were retired." : "Your cart has closed.",
        deepLink: "/buyer/cart",
        data: { cartId: event.cartId },
      });
    case "run.started": {
      const recipients = unique([event.buyerId, event.runnerId, ...(event.sellerParticipantIds ?? [])]);
      return draftsFor(sourceEventId, occurredAt, event, recipients, {
        title: "Run started",
        body: "A run has started for a cart you are participating in.",
        data: { runId: event.runId },
      }, (recipientId) => runLink(event.runId, recipientId, event.buyerId, event.runnerId));
    }
    case "run.updated": {
      const run = event.run;
      const recipients = unique([run.buyerId, run.runnerId, ...(run.sellerParticipantIds ?? [])]);
      return draftsFor(sourceEventId, occurredAt, event, recipients, {
        title: run.disputed ? "Dispute opened" : `Run ${run.status}`,
        body: run.disputed ? "Settlement is paused while the dispute is reviewed." : `Your run is now ${run.status}.`,
        data: { runId: run.id, status: run.status, disputed: run.disputed ?? false },
      }, (recipientId) => runLink(run.id, recipientId, run.buyerId, run.runnerId));
    }
    case "handoff.initiated":
    case "handoff.confirmed": {
      const recipients = unique([event.buyerId, event.runnerId, ...(event.sellerParticipantIds ?? [])]);
      return draftsFor(sourceEventId, occurredAt, event, recipients, {
        title: event.type === "handoff.confirmed" ? "Handoff confirmed" : "Handoff started",
        body: event.type === "handoff.confirmed" ? "A handoff was confirmed with photo evidence." : "A handoff is awaiting confirmation.",
        data: { runId: event.runId, handoffId: event.handoffId },
      }, (recipientId) => runLink(event.runId, recipientId, event.buyerId, event.runnerId, event.handoffId));
    }
    case "settlement.released": {
      const recipients = unique([event.buyerId, event.runnerId, ...event.sellers.map((seller) => seller.sellerId)]);
      return draftsFor(sourceEventId, occurredAt, event, recipients, {
        category: "payment",
        title: "Settlement released",
        body: `The ${event.mode} settlement for your run has been released for dispatch.`,
        data: { runId: event.runId, mode: event.mode },
        email: "receipt",
      }, () => archivedRunLink(event.runId, "closed"));
    }
    case "run.retired": {
      const recipients = unique([event.buyerId, event.runnerId, ...event.settlementLegs.map((seller) => seller.sellerId)]);
      return draftsFor(sourceEventId, occurredAt, event, recipients, {
        title: event.dispute ? "Disputed run closed" : "Run closed",
        body: `The run closed as ${event.status}.`,
        data: { runId: event.runId, status: event.status },
      }, () => archivedRunLink(event.runId, event.status));
    }
    case "store.recorded":
      return draftsFor(sourceEventId, occurredAt, event, [event.store.sellerParticipantId], {
        title: "Store registered",
        body: `${event.store.name} is registered in ${event.store.market}.`,
        deepLink: "/seller",
        data: { storeId: event.store.id },
      });
    default:
      // Queue-only payment execution and legacy events without recipient attribution
      // are handled by explicit trusted transitions, never inferred here.
      return [];
  }
}
