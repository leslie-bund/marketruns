import { z } from "zod";
import { KoboSchema, RequestIdSchema, TimestampSchema } from "./primitives.js";

/**
 * Payments and KYC speak in captures, holds, releases, and verifications
 * only — no vendor names, no vendor API shapes (ADR-0009). Switching or
 * dual-homing a provider is an integration-layer change, never a wire change.
 */

/** Edge → buyer: funds earmarked for a Cart/Run are held. */
export const PaymentHoldPlacedSchema = z.object({
  type: z.literal("payment.hold-placed"),
  holdId: z.string().min(1),
  amountKobo: KoboSchema,
  placedAt: TimestampSchema,
});
export type PaymentHoldPlaced = z.infer<typeof PaymentHoldPlacedSchema>;

/** Edge → participants (via settlement): held funds captured against a hold. */
export const PaymentFundsCapturedSchema = z.object({
  type: z.literal("payment.funds-captured"),
  captureId: z.string().min(1),
  holdId: z.string().min(1).optional(),
  amountKobo: KoboSchema,
  capturedAt: TimestampSchema,
});
export type PaymentFundsCaptured = z.infer<typeof PaymentFundsCapturedSchema>;

/** Edge → buyer: held funds released back (refunds flow only through settlement, ADR-0007). */
export const PaymentFundsReleasedSchema = z.object({
  type: z.literal("payment.funds-released"),
  releaseId: z.string().min(1),
  holdId: z.string().min(1).optional(),
  amountKobo: KoboSchema,
  releasedAt: TimestampSchema,
});
export type PaymentFundsReleased = z.infer<typeof PaymentFundsReleasedSchema>;

/** `preverified` is a staging-only trusted fixture, never production verification. */
export const KycVerificationStatusSchema = z.enum(["pending", "preverified", "verified", "failed"]);
export type KycVerificationStatus = z.infer<typeof KycVerificationStatusSchema>;

/** Edge → participant: identity verification outcome. */
export const KycVerificationResultSchema = z.object({
  type: z.literal("kyc.verification-result"),
  verificationId: z.string().min(1),
  status: KycVerificationStatusSchema,
  verifiedAt: TimestampSchema.optional(),
});
export type KycVerificationResult = z.infer<typeof KycVerificationResultSchema>;

/* ------------------------------------------------------------------------ */
/* Payment dispatch (apps/payments queue) — the settlement function has       */
/* ALREADY decided the money (ADR-0007/0008); dispatch is execution, never a  */
/* new money decision. Vendor names stay out of the wire (ADR-0009).          */
/* ------------------------------------------------------------------------ */

/**
 * Payout accounts a dispatch leg can target. Deliberately NOT the ledger
 * chart of accounts (those are bookkeeping); these are the parties a PSP
 * transfer can reach. Buyer refunds ride `payment.funds-released` against
 * the hold, not this queue.
 */
export const DispatchAccountSchema = z.enum(["seller", "runner", "platform"]);
export type DispatchAccount = z.infer<typeof DispatchAccountSchema>;

/** One payout leg computed by the settlement function, verbatim. */
export const PaymentDispatchLegSchema = z.object({
  account: DispatchAccountSchema,
  /** Participant paid; the platform leg carries the literal "platform". */
  partyId: z.string().min(1),
  amountKobo: KoboSchema,
  memo: z.string(),
});
export type PaymentDispatchLeg = z.infer<typeof PaymentDispatchLegSchema>;

/**
 * Edge (RunDO) → payment queue: settlement released, dispatch these legs.
 * `idempotencyKey` is `settlement:<settlementRecordId>` — the settlement
 * already ran, so re-delivery of this message is a replay of the SAME
 * execution request, and the consumer must no-op on it.
 */
export const PaymentDispatchRequestedSchema = z.object({
  type: z.literal("payment.dispatch-requested"),
  settlementRecordId: z.string().min(1),
  runId: z.string().min(1),
  market: z.string().min(1),
  legs: z.array(PaymentDispatchLegSchema).min(1),
  idempotencyKey: z.string().min(1),
  /** Correlation id of the request that released the settlement; absent on timer releases. Append-only. */
  requestId: RequestIdSchema.optional(),
});
export type PaymentDispatchRequested = z.infer<typeof PaymentDispatchRequestedSchema>;

/**
 * States of one persisted dispatch attempt. Lifecycle:
 *   pending   — recorded, not yet dispatched;
 *   queued    — accepted by the provider, not yet handed to the payout rails;
 *   sent      — in-flight on the rails, completion not yet confirmed
 *               (the synchronous StubDispatcher also reports "sent": it has
 *               nothing further to track);
 *   completed — confirmed settled at the destination account (terminal);
 *   failed    — not moved / terminally rejected (terminal, replayable).
 * "completed" was added when the first real provider landed (ADR-0023):
 * provider acceptance is honestly distinct from settlement at the bank.
 */
export const PaymentDispatchStatusSchema = z.enum(["pending", "sent", "queued", "failed", "completed"]);
export type PaymentDispatchStatus = z.infer<typeof PaymentDispatchStatusSchema>;

/** Ops read model over the payment_dispatches table (apps/payments /dispatches). */
export const PaymentDispatchViewSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  settlementRecordId: z.string().min(1),
  runId: z.string().min(1),
  market: z.string().min(1),
  account: DispatchAccountSchema,
  partyId: z.string().min(1),
  amountKobo: KoboSchema,
  memo: z.string(),
  status: PaymentDispatchStatusSchema,
  /** Integration-layer transfer reference (vendor-neutral, ADR-0009). */
  providerRef: z.string().min(1).nullable(),
  failureReason: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type PaymentDispatchView = z.infer<typeof PaymentDispatchViewSchema>;

/* ------------------------------------------------------------------------ */
/* Collection: charge holds + the refund rail (ADR-0024 follow-up). The hold  */
/* is the buyer's collected money, verified server-side at the payments        */
/* worker; the refund rail executes the settlement's buyerRefundKobo leg       */
/* against that hold (ADR-0023: refunds release against the hold). Vendor      */
/* names stay out of the wire (ADR-0009): txRef is the client-generated        */
/* checkout reference, providerTxId the integration-layer transaction id.      */
/* ------------------------------------------------------------------------ */

/** Lifecycle of a payment hold over collected buyer funds. */
export const PaymentHoldStatusSchema = z.enum(["held", "released", "partially-refunded", "refunded", "failed"]);
export type PaymentHoldStatus = z.infer<typeof PaymentHoldStatusSchema>;

/**
 * Buyer client → payments worker: confirm a completed checkout charge and
 * place the hold. The worker verifies with the provider server-side — client
 * amounts are never trusted; `expectedAmountKobo` is a cross-check, not the
 * source of truth. Idempotent on `txRef`.
 */
export const PaymentChargeConfirmRequestSchema = z
  .object({
    /** Client-generated checkout reference (tx_ref). */
    txRef: z.string().min(1).optional(),
    /** Provider transaction id (data.id from the checkout callback/webhook). */
    transactionId: z.union([z.string().min(1), z.number().int().positive()]).optional(),
    expectedAmountKobo: KoboSchema,
    buyerId: z.string().min(1),
    cartId: z.string().min(1),
  })
  .refine((value) => value.txRef !== undefined || value.transactionId !== undefined, {
    message: "txRef or transactionId is required",
  });
export type PaymentChargeConfirmRequest = z.infer<typeof PaymentChargeConfirmRequestSchema>;

/** Payments worker → buyer client: the hold is placed (or already existed). */
export const PaymentChargeConfirmResponseSchema = z.object({
  holdId: z.string().min(1),
  txRef: z.string().min(1),
  amountKobo: KoboSchema,
  status: PaymentHoldStatusSchema,
});
export type PaymentChargeConfirmResponse = z.infer<typeof PaymentChargeConfirmResponseSchema>;

/** Ops read model over the payment_holds table (apps/payments /payments/holds). */
export const PaymentHoldViewSchema = z.object({
  id: z.string().min(1),
  txRef: z.string().min(1),
  /** Integration-layer transaction reference (vendor-neutral, ADR-0009). */
  providerTxId: z.string().min(1),
  cartId: z.string().min(1),
  /** Bound at checkout once the run exists; NULL before. */
  runId: z.string().min(1).nullable(),
  buyerId: z.string().min(1),
  amountKobo: KoboSchema,
  /** Provider-reported payment method (e.g. card, bank_transfer) — drives the refund rail. */
  paymentMethod: z.string().min(1),
  status: PaymentHoldStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type PaymentHoldView = z.infer<typeof PaymentHoldViewSchema>;

/**
 * Edge (RunDO) → payment queue: the settlement outcome carries a buyer refund
 * (buyerRefundKobo > 0, ADR-0008 aborts never refund fully). Execution only —
 * the settlement function already decided the amount; the payments worker
 * refunds against the run's hold. Buyer refunds ride THIS queue, not the
 * payout dispatcher (ADR-0023).
 */
export const PaymentRefundRequestedSchema = z.object({
  type: z.literal("payment.refund-requested"),
  settlementRecordId: z.string().min(1),
  runId: z.string().min(1),
  buyerId: z.string().min(1),
  amountKobo: KoboSchema,
  idempotencyKey: z.string().min(1),
  /** Correlation id of the request that released the settlement; absent on timer releases. Append-only. */
  requestId: RequestIdSchema.optional(),
});
export type PaymentRefundRequested = z.infer<typeof PaymentRefundRequestedSchema>;

/**
 * States of one persisted refund. Lifecycle:
 *   pending       — recorded, not yet executed;
 *   processing    — the provider accepted the refund (card refunds settle in
 *                   days; terminal enough for the hold ledger);
 *   completed     — provider confirmed the refund landed;
 *   failed        — not executed / terminally rejected (retried, then DLQ);
 *   refund-manual — the payment method has no API refund rail (non-card);
 *                   ops refunds the buyer manually. Honest, terminal.
 */
export const PaymentRefundStatusSchema = z.enum(["pending", "processing", "completed", "failed", "refund-manual"]);
export type PaymentRefundStatus = z.infer<typeof PaymentRefundStatusSchema>;

/** Ops read model over the payment_refunds table (apps/payments /payments/refunds). */
export const PaymentRefundViewSchema = z.object({
  id: z.string().min(1),
  holdId: z.string().min(1),
  settlementRecordId: z.string().min(1),
  amountKobo: KoboSchema,
  status: PaymentRefundStatusSchema,
  /** Integration-layer refund reference (vendor-neutral, ADR-0009). */
  providerRef: z.string().min(1).nullable(),
  failureReason: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type PaymentRefundView = z.infer<typeof PaymentRefundViewSchema>;

/* ------------------------------------------------------------------------ */
/* Payout accounts: bank directory + account resolution + per-participant     */
/* saved accounts (the RecipientResolver's DB-first source).                  */
/* ------------------------------------------------------------------------ */

/** One bank in the provider's transfer directory (NG). */
export const PaymentBankViewSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
});
export type PaymentBankView = z.infer<typeof PaymentBankViewSchema>;

/** Client → payments worker: resolve an account number to its account name. */
export const PayoutAccountResolveRequestSchema = z.object({
  bankCode: z.string().min(1),
  accountNumber: z.string().min(1),
});
export type PayoutAccountResolveRequest = z.infer<typeof PayoutAccountResolveRequestSchema>;

export const PayoutAccountResolveResponseSchema = z.object({
  bankCode: z.string().min(1),
  accountNumber: z.string().min(1),
  accountName: z.string().min(1),
});
export type PayoutAccountResolveResponse = z.infer<typeof PayoutAccountResolveResponseSchema>;

/**
 * Client → payments worker: save the caller's payout account. The account is
 * ALWAYS resolved with the provider first — an unresolved account is never
 * stored (a wrong account silently misdirects settlement money).
 */
export const PayoutAccountUpsertRequestSchema = z.object({
  participantId: z.string().min(1),
  bankCode: z.string().min(1),
  accountNumber: z.string().min(1),
});
export type PayoutAccountUpsertRequest = z.infer<typeof PayoutAccountUpsertRequestSchema>;

/** Read model over the payout_accounts table. */
export const PayoutAccountViewSchema = z.object({
  participantId: z.string().min(1),
  bankCode: z.string().min(1),
  accountNumber: z.string().min(1),
  accountName: z.string().min(1),
  verifiedAt: TimestampSchema,
  /** Set on revoke; the account no longer resolves for dispatches. */
  revokedAt: TimestampSchema.nullable(),
});
export type PayoutAccountView = z.infer<typeof PayoutAccountViewSchema>;
