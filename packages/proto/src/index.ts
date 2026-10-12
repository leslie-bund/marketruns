import { z } from "zod";
import { IntentExpiredSchema, IntentPostedSchema, IntentRecordedSchema } from "./intent.js";
import {
  NegotiationPriceAdjustedSchema,
  ProductOfferedSchema,
  ProductWithdrawnSchema,
} from "./negotiation.js";
import {
  CartUpdatedSchema,
  CheckoutAcceptedSchema,
  CheckoutRequestedSchema,
  ProductAcceptedSchema,
} from "./cart.js";
import {
  HandoffChallengeScannedSchema,
  HandoffConfirmedSchema,
  HandoffInitiatedSchema,
  HandoffPhotoCapturedSchema,
  RunUpdatedSchema,
  RunnerLocationUpdatedSchema,
} from "./run.js";
import { SettlementReleasedSchema } from "./settlement.js";
import { CartRetiredSchema, ProductRetiredSchema, RunRetiredSchema } from "./archive.js";
import {
  KycVerificationResultSchema,
  PaymentFundsCapturedSchema,
  PaymentFundsReleasedSchema,
  PaymentHoldPlacedSchema,
} from "./payments.js";

export * from "./primitives.js";
export * from "./intent.js";
export * from "./negotiation.js";
export * from "./cart.js";
export * from "./run.js";
export * from "./settlement.js";
export * from "./archive.js";
export * from "./payments.js";

/**
 * Everything a client (buyer / seller / runner app) may send to the edge,
 * over HTTP or the WebSocket gateways. Discriminated on `type`.
 */
export const ClientCommandSchema = z.discriminatedUnion("type", [
  IntentPostedSchema,
  NegotiationPriceAdjustedSchema,
  ProductAcceptedSchema,
  CheckoutRequestedSchema,
  HandoffChallengeScannedSchema,
  HandoffPhotoCapturedSchema,
  RunnerLocationUpdatedSchema,
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

/**
 * Everything the edge may push to clients, or place on queues: live lifecycle
 * events, retirement snapshots (archive queue payloads), and the
 * vendor-neutral payment/KYC notifications (ADR-0009).
 */
export const ServerEventSchema = z.discriminatedUnion("type", [
  IntentRecordedSchema,
  IntentExpiredSchema,
  ProductOfferedSchema,
  ProductWithdrawnSchema,
  NegotiationPriceAdjustedSchema,
  CartUpdatedSchema,
  CheckoutAcceptedSchema,
  RunUpdatedSchema,
  HandoffInitiatedSchema,
  HandoffConfirmedSchema,
  SettlementReleasedSchema,
  ProductRetiredSchema,
  CartRetiredSchema,
  RunRetiredSchema,
  PaymentHoldPlacedSchema,
  PaymentFundsCapturedSchema,
  PaymentFundsReleasedSchema,
  KycVerificationResultSchema,
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
