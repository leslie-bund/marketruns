import { z } from "zod";
import { DeliverySchema, GeoLocationSchema, KoboSchema, LocationFixSchema, TimestampSchema } from "./primitives.js";

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

export const RunHandoffSchema = z.object({
  id: z.string().min(1),
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
  autoConfirmed: z.boolean().optional(),
  /**
   * Photo-required confirm (owner decision amending ADR-0019): a handoff
   * never confirms without `photoCaptureRef`. TRUE while a pending handoff is
   * past its auto-confirm deadline with no photo attached — auto-confirm is
   * paused and every screen should show "waiting for runner photo evidence".
   * Additive/optional; computed at emission, never stored.
   */
  awaitingPhoto: z.boolean().optional(),
});
export type RunHandoff = z.infer<typeof RunHandoffSchema>;

export const RunSchema = z.object({
  id: z.string().min(1),
  market: z.string().min(1),
  status: RunStatusSchema,
  floorRateKobo: KoboSchema,
  delivery: DeliverySchema,
  stops: z.array(RunStopSchema),
  handoffs: z.array(RunHandoffSchema),
  /** Trusted participant attribution used by the notification pipeline; absent on legacy reads. */
  buyerId: z.string().min(1).optional(),
  runnerId: z.string().min(1).optional(),
  sellerParticipantIds: z.array(z.string().min(1)).optional(),
  location: GeoLocationSchema.optional(),
  /** Whole-trip routed path, computed at checkout and cached here (routing is called at checkout, cached in the RunDO). */
  route: RunRouteSchema.optional(),
  /**
   * Durable dispute state, surfaced on every run.updated once the RunDO has
   * it. Additive/optional so older clients keep parsing (they simply never
   * see the fields). NULL raiser = disputed before attribution existed, or an
   * anonymous dispute.
   */
  disputed: z.boolean().optional(),
  disputeRaisedByParticipantId: z.string().min(1).nullable().optional(),
  /** Final-delivery stamp; clients compute the 30-minute dispute-window countdown from it. NULL until delivered. */
  finalDeliveryAt: TimestampSchema.nullable().optional(),
});
export type Run = z.infer<typeof RunSchema>;

/**
 * Client-safe projection of one live run, served by the edge's runner
 * run-discovery endpoint (GET /markets/:market/runs/active) from the
 * live_runs index — never by listing DOs (ADR-0017).
 */
export const ActiveRunSchema = z.object({
  runId: z.string().min(1),
  market: z.string().min(1),
  status: RunStatusSchema,
  buyerId: z.string().min(1),
  startedAt: TimestampSchema,
  stopCount: z.number().int().nonnegative(),
});
export type ActiveRun = z.infer<typeof ActiveRunSchema>;

/**
 * GET /markets/:market/runs/active response. The live_runs index is an
 * oversight index, not doctrine: when it is unreachable the edge degrades to
 * an empty list with `warning` set rather than breaking the runner screen.
 */
export const ActiveRunsResponseSchema = z.object({
  runs: z.array(ActiveRunSchema),
  /** Set when the list is empty because the index was unavailable, not because no runs are live. */
  warning: z.string().optional(),
});
export type ActiveRunsResponse = z.infer<typeof ActiveRunsResponseSchema>;

/** Edge → participants: Run state after any transition or Handoff. */
export const RunUpdatedSchema = z.object({
  type: z.literal("run.updated"),
  run: RunSchema,
});
export type RunUpdated = z.infer<typeof RunUpdatedSchema>;

/** Runner → edge: throttled fire-and-forget location stream, latest fix only. */
export const RunnerLocationUpdatedSchema = LocationFixSchema.extend({
  type: z.literal("run.location-updated"),
  runId: z.string().min(1),
  /** Legacy dev fixtures omit these; deployed session writes reject their absence. */
  observedAt: TimestampSchema.optional(),
  accuracyMeters: z.number().nonnegative().optional(),
});
export type RunnerLocationUpdated = z.infer<typeof RunnerLocationUpdatedSchema>;

/** Edge → participants: a Handoff opened; the 3-min auto-confirm clock starts. */
export const HandoffInitiatedSchema = z.object({
  type: z.literal("handoff.initiated"),
  handoffId: z.string().min(1),
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

/** Runner → edge: the one-time QR challenge at the Exchange Point was scanned. */
export const HandoffChallengeScannedSchema = z.object({
  type: z.literal("handoff.challenge-scanned"),
  handoffId: z.string().min(1),
  runId: z.string().min(1),
  scannedAt: TimestampSchema,
});
export type HandoffChallengeScanned = z.infer<typeof HandoffChallengeScannedSchema>;

/** Runner → edge: photo evidence captured; `photoCaptureRef` is the signed R2 reference. */
export const HandoffPhotoCapturedSchema = z.object({
  type: z.literal("handoff.photo-captured"),
  handoffId: z.string().min(1),
  photoCaptureRef: z.string().min(1),
  capturedAt: TimestampSchema,
});
export type HandoffPhotoCaptured = z.infer<typeof HandoffPhotoCapturedSchema>;

/**
 * Edge → participants: the Handoff is confirmed — explicitly, or
 * auto-confirmed after 3 minutes of buyer silence (buyer silence = consent).
 * Either way a photo is attached first: confirms are never photoless (owner
 * decision amending ADR-0019).
 */
export const HandoffConfirmedSchema = z.object({
  type: z.literal("handoff.confirmed"),
  handoffId: z.string().min(1),
  runId: z.string().min(1),
  confirmedAt: TimestampSchema,
  autoConfirmed: z.boolean(),
  buyerId: z.string().min(1).optional(),
  runnerId: z.string().min(1).optional(),
  sellerParticipantIds: z.array(z.string().min(1)).optional(),
});
export type HandoffConfirmed = z.infer<typeof HandoffConfirmedSchema>;
