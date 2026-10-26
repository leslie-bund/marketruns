import { z } from "zod";
import { DeliverySchema, GeoLocationSchema, KoboSchema, TimestampSchema } from "./primitives.js";

/**
 * One Runner's trip collecting every item in one Cart and delivering them.
 * One Run per Cart (GLOSSARY.md). The shape stays auction-ready for v2
 * (ADR-0013) without shipping auction logic.
 */
export const RunStatusSchema = z.enum([
  "unassigned",
  "assigned",
  "collecting",
  "delivering",
  "delivered",
  "closed",
  "aborted",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StopStatusSchema = z.enum(["next", "upcoming", "completed"]);
export type StopStatus = z.infer<typeof StopStatusSchema>;

/** A lat/lng pair on the wire (no timestamp — static geography). */
export const GeoPointValueSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type GeoPointValue = z.infer<typeof GeoPointValueSchema>;

export const RunStopSchema = z.object({
  sellerName: z.string().min(1),
  storeId: z.string().min(1).optional(),
  sellerParticipantId: z.string().min(1).optional(),
  exchangePoint: z.string().min(1),
  shopItems: z.array(z.string().min(1)),
  status: StopStatusSchema,
  /** Routed leg from the previous waypoint to this stop (OSRM at checkout; absent when routing was unreachable). */
  legDistanceMeters: z.number().nonnegative().optional(),
  legDurationSeconds: z.number().nonnegative().optional(),
  /** Resolved at checkout from the market's geo table — powers the trip map. */
  location: GeoPointValueSchema.optional(),
});
export type RunStop = z.infer<typeof RunStopSchema>;

/** Routed trip summary cached on the Run at checkout. */
export const RunRouteSchema = z.object({
  distanceMeters: z.number().nonnegative(),
  durationSeconds: z.number().nonnegative(),
  /** Downsampled path for map display (runner start → stops → delivery). */
  geometry: z.array(GeoPointValueSchema).optional(),
  /** Delivery destination coordinate. */
  destination: GeoPointValueSchema.optional(),
});
export type RunRoute = z.infer<typeof RunRouteSchema>;

export const HandoffTypeSchema = z.enum(["pickup", "delivery"]);
export type HandoffType = z.infer<typeof HandoffTypeSchema>;

export const DeliveryReceiverSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("buyer") }),
  z.object({ kind: z.literal("designated"), name: z.string().trim().min(1).max(100) }),
]);
export type DeliveryReceiver = z.infer<typeof DeliveryReceiverSchema>;

export const RunHandoffSchema = z.object({
  id: z.string().min(1),
  type: HandoffTypeSchema,
  exchangePoint: z.string().min(1),
  counterparty: z.string().min(1),
  status: z.enum(["pending", "confirmed"]),
  requestedAt: TimestampSchema,
  /**
   * The evidence layer on the wire (ADR-0007): the signed R2 reference the
   * runner captured at this exchange point, plus the handshake timestamps.
   * All additive/optional — older clients ignore them; absent until the
   * runner's capture lands (photo) or the handoff confirms.
   */
  photoCaptureRef: z.string().min(1).optional(),
  photoCapturedAt: TimestampSchema.optional(),
  scannedAt: TimestampSchema.optional(),
  confirmedAt: TimestampSchema.optional(),
  /** Server attribution: buyer participant id, or "receiver" for account-less delegated receipt. */
  confirmedBy: z.string().min(1).optional(),
  autoConfirmed: z.boolean().optional(),
  awaitingPhoto: z.boolean().optional(),
  codeExpiresAt: TimestampSchema.optional(),
});
export type RunHandoff = z.infer<typeof RunHandoffSchema>;

export const RunSchema = z.object({
  id: z.string().min(1),
  market: z.string().min(1),
  status: RunStatusSchema,
  floorRateKobo: KoboSchema,
  delivery: DeliverySchema,
  receiver: DeliveryReceiverSchema.optional(),
  delegatedByParticipantId: z.string().min(1).optional(),
  stops: z.array(RunStopSchema),
  handoffs: z.array(RunHandoffSchema),
  buyerId: z.string().min(1).optional(),
  runnerId: z.string().min(1).optional(),
  sellerParticipantIds: z.array(z.string().min(1)).optional(),
  location: GeoLocationSchema.optional(),
  route: RunRouteSchema.optional(),
  disputed: z.boolean().optional(),
  disputeRaisedByParticipantId: z.string().min(1).nullable().optional(),
  finalDeliveryAt: TimestampSchema.nullable().optional(),
});
export type Run = z.infer<typeof RunSchema>;

export const ActiveRunSchema = z.object({
  runId: z.string().min(1),
  market: z.string().min(1),
  status: RunStatusSchema,
  buyerId: z.string().min(1),
  startedAt: TimestampSchema,
  stopCount: z.number().int().nonnegative(),
});
export type ActiveRun = z.infer<typeof ActiveRunSchema>;

export const ActiveRunsResponseSchema = z.object({
  runs: z.array(ActiveRunSchema),
  warning: z.string().optional(),
});
export type ActiveRunsResponse = z.infer<typeof ActiveRunsResponseSchema>;

export const RunUpdatedSchema = z.object({ type: z.literal("run.updated"), run: RunSchema });
export type RunUpdated = z.infer<typeof RunUpdatedSchema>;

/** observedAt is accepted for wire compatibility but ignored; the server stamps receipt. */
export const RunnerLocationUpdatedSchema = z.object({
  type: z.literal("run.location-updated"),
  runId: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  observedAt: TimestampSchema.optional(),
});
export type RunnerLocationUpdated = z.infer<typeof RunnerLocationUpdatedSchema>;

export const HandoffInitiatedSchema = z.object({
  type: z.literal("handoff.initiated"),
  handoffId: z.string().min(1),
  handoffType: HandoffTypeSchema,
  runId: z.string().min(1),
  exchangePointId: z.string().min(1),
  counterparty: z.string().min(1),
  requestedAt: TimestampSchema,
  deadline: TimestampSchema,
  buyerId: z.string().min(1).optional(),
  runnerId: z.string().min(1).optional(),
  sellerParticipantIds: z.array(z.string().min(1)).optional(),
});
export type HandoffInitiated = z.infer<typeof HandoffInitiatedSchema>;

/** The payload came from a server-issued QR; a bare handoff id is never sufficient. */
export const HandoffChallengeScannedSchema = z.object({
  type: z.literal("handoff.challenge-scanned"),
  handoffId: z.string().min(1),
  runId: z.string().min(1),
  challenge: z.string().min(6).max(1000),
});
export type HandoffChallengeScanned = z.infer<typeof HandoffChallengeScannedSchema>;

/** capturedAt is accepted for compatibility but ignored; the server stamps evidence. */
export const HandoffPhotoCapturedSchema = z.object({
  type: z.literal("handoff.photo-captured"),
  handoffId: z.string().min(1),
  photoCaptureRef: z.string().min(1),
  capturedAt: TimestampSchema.optional(),
});
export type HandoffPhotoCaptured = z.infer<typeof HandoffPhotoCapturedSchema>;

export const HandoffConfirmedSchema = z.object({
  type: z.literal("handoff.confirmed"),
  handoffId: z.string().min(1),
  runId: z.string().min(1),
  confirmedAt: TimestampSchema,
  confirmedBy: z.string().min(1).optional(),
  autoConfirmed: z.boolean(),
  buyerId: z.string().min(1).optional(),
  runnerId: z.string().min(1).optional(),
  sellerParticipantIds: z.array(z.string().min(1)).optional(),
});
export type HandoffConfirmed = z.infer<typeof HandoffConfirmedSchema>;

export const DeliveryCodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  expiresAt: TimestampSchema,
});
export type DeliveryCode = z.infer<typeof DeliveryCodeSchema>;
