import { z } from "zod";
import { DeliverySchema, GeoLocationSchema, KoboSchema, TimestampSchema } from "./primitives.js";

/**
 * One Runner's trip collecting every item in one Cart and delivering them.
 * One Run per Cart (GLOSSARY.md). The shape stays auction-ready for v2
 * (ADR-0013) without shipping auction logic.
 */
export const RunStatusSchema = z.enum([
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

export const RunStopSchema = z.object({
  sellerName: z.string().min(1),
  exchangePoint: z.string().min(1),
  shopItems: z.array(z.string().min(1)),
  status: StopStatusSchema,
});
export type RunStop = z.infer<typeof RunStopSchema>;

export const RunHandoffSchema = z.object({
  id: z.string().min(1),
  exchangePoint: z.string().min(1),
  counterparty: z.string().min(1),
  status: z.enum(["pending", "confirmed"]),
  requestedAt: TimestampSchema,
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
  location: GeoLocationSchema.optional(),
});
export type Run = z.infer<typeof RunSchema>;

/** Edge → participants: Run state after any transition or Handoff. */
export const RunUpdatedSchema = z.object({
  type: z.literal("run.updated"),
  run: RunSchema,
});
export type RunUpdated = z.infer<typeof RunUpdatedSchema>;

/** Runner → edge: throttled fire-and-forget location stream. */
export const RunnerLocationUpdatedSchema = z.object({
  type: z.literal("run.location-updated"),
  runId: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  observedAt: TimestampSchema,
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
 */
export const HandoffConfirmedSchema = z.object({
  type: z.literal("handoff.confirmed"),
  handoffId: z.string().min(1),
  runId: z.string().min(1),
  confirmedAt: TimestampSchema,
  autoConfirmed: z.boolean(),
});
export type HandoffConfirmed = z.infer<typeof HandoffConfirmedSchema>;
