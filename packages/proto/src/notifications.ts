import { z } from "zod";
import { TimestampSchema } from "./primitives.js";

/** Durable, participant-facing notifications. Realtime frames are only a hint; the read API is authoritative. */
export const NotificationCategorySchema = z.enum(["marketplace", "payment", "security", "system"]);
export type NotificationCategory = z.infer<typeof NotificationCategorySchema>;

export const NotificationChannelSchema = z.enum(["websocket", "email"]);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationDeepLinkSchema = z.string().regex(/^\/[A-Za-z0-9_./?=&%:-]*$/).max(500);
export type NotificationDeepLink = z.infer<typeof NotificationDeepLinkSchema>;

export const NotificationSchema = z.object({
  id: z.string().min(1),
  recipientId: z.string().min(1),
  sourceEventId: z.string().min(1),
  sourceEventType: z.string().min(1),
  dedupeKey: z.string().min(1),
  category: NotificationCategorySchema,
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(1000),
  deepLink: NotificationDeepLinkSchema.optional(),
  data: z.record(z.unknown()).default({}),
  createdAt: TimestampSchema,
  readAt: TimestampSchema.nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationListResponseSchema = z.object({
  items: z.array(NotificationSchema),
  total: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;

export const NotificationMarkReadRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
});
export type NotificationMarkReadRequest = z.infer<typeof NotificationMarkReadRequestSchema>;

export const NotificationMarkReadResponseSchema = z.object({ updated: z.number().int().nonnegative() });
export type NotificationMarkReadResponse = z.infer<typeof NotificationMarkReadResponseSchema>;

/** Best-effort participant-socket frame. Clients must refresh the durable API after reconnecting. */
export const NotificationCreatedSchema = z.object({
  type: z.literal("notification.created"),
  notification: NotificationSchema,
});
export type NotificationCreated = z.infer<typeof NotificationCreatedSchema>;

/** Queue envelope for an existing domain ServerEvent. The id is assigned by the trusted emitter. */
export const NotificationSourceEnvelopeSchema = z.object({
  sourceEventId: z.string().min(1),
  occurredAt: TimestampSchema,
  event: z.unknown(),
});
export type NotificationSourceEnvelope = z.infer<typeof NotificationSourceEnvelopeSchema>;

/**
 * Trusted worker-to-worker transition input for sources whose transition is not
 * already represented by a domain event (payments and security). Recipients are
 * always resolved and attached by the emitting worker, never by a client.
 */
export const NotificationTransitionSchema = z.object({
  sourceEventId: z.string().min(1),
  sourceEventType: z.string().min(1),
  recipientId: z.string().min(1),
  dedupeKey: z.string().min(1),
  category: NotificationCategorySchema,
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(1000),
  deepLink: NotificationDeepLinkSchema.optional(),
  data: z.record(z.unknown()).default({}),
  occurredAt: TimestampSchema,
  email: z.enum(["receipt", "security"]).optional(),
});
export type NotificationTransition = z.infer<typeof NotificationTransitionSchema>;

// Transition first: z.unknown() makes an envelope's event key optional in zod v3,
// so the narrower trusted-transition shape must get the first parse attempt.
export const NotificationQueueMessageSchema = z.union([NotificationTransitionSchema, NotificationSourceEnvelopeSchema]);
export type NotificationQueueMessage = z.infer<typeof NotificationQueueMessageSchema>;

/** Canonical JSON makes content-derived source ids stable across queue serialization and worker boundaries. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** Deterministic id for an actual source event; queue replays therefore collapse to the same durable rows. */
export function notificationSourceEventId(source: "edge" | "archive", event: unknown): string {
  const input = canonicalJson(event);
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  const type = typeof event === "object" && event !== null && "type" in event ? String(event.type) : "event";
  return `${source}:${type}:${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

export function notificationSourceEnvelope(source: "edge" | "archive", event: unknown): NotificationSourceEnvelope {
  return { sourceEventId: notificationSourceEventId(source, event), occurredAt: Date.now(), event };
}
