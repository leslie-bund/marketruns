import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type {
  PaymentRefundResolution,
  PaymentRefundResolutionStatus,
  PaymentRefundResolutionView,
  PaymentRefundStatus,
  PaymentRefundView,
} from "@market-runs/proto";
import type { PaymentRefundRequested } from "@market-runs/proto";
import { paymentHolds, paymentRefundResolutions, paymentRefunds } from "../../../infra/drizzle/schema.js";
import type { createDatabase } from "./db.js";
import type { ChargeGateway } from "./gateway.js";
import { retryDelaySeconds, type QueueMessageLike } from "./consume.js";
import type { HoldRow, HoldStore } from "./holds.js";
import { paymentNotification, type PaymentNotificationSink } from "./notifications.js";

/**
 * The refund rail (ADR-0023/0024 follow-up): buyer refunds release against
 * the buyer's hold — they never ride the payout dispatcher. RunDO emits
 * payment.refund-requested when the settlement outcome carries
 * buyerRefundKobo > 0; this consumer executes that amount against the run's
 * hold. The settlement function decided the kobo (ADR-0007/0008); nothing
 * here recomputes.
 *
 * Method matrix (honest by construction):
 *   card      → provider refund API; status "processing" (card refunds settle
 *               in days at the shipped provider), providerRef recorded.
 *   non-card  → no API rail (a bank refund needs the buyer's account, which
 *               the system deliberately doesn't collect) → "refund-manual",
 *               terminal, visible to ops via GET /payments/refunds.
 *   no hold   → the run settled without a gated collection (dev posture);
 *               acknowledged and logged, nothing to refund.
 *
 * Idempotency: refund ids are `refund:<settlementRecordId>` with a UNIQUE
 * settlement_record_id — one settlement refunds once; queue redelivery is a
 * no-op replay. Retry/backoff/DLQ posture matches dispatches (the consumer's
 * message.retry, the queue's max_retries + DLQ).
 */

export interface RefundResolutionRow {
  action: PaymentRefundResolution["action"];
  status: PaymentRefundResolutionStatus;
  providerRef: string | null;
  evidenceRef: string;
  note: string;
  resolvedBy: string;
  resolvedAt: Date;
}

export interface RefundRow {
  id: string;
  holdId: string;
  settlementRecordId: string;
  amountKobo: number;
  status: PaymentRefundStatus;
  providerRef: string | null;
  failureReason: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
  resolution: RefundResolutionRow | null;
}

export interface RefundResolutionCommand {
  resolvedBy: string;
  resolution: PaymentRefundResolution;
  /** Worker-owned; callers cannot supply this over the wire. */
  resolvedAt: Date;
}

export type RefundResolutionResult =
  | { outcome: "applied" | "replayed"; refund: RefundRow }
  | { outcome: "conflict" | "invalid-state"; refund: RefundRow }
  | { outcome: "not-found"; refund: null };

export interface RefundListFilter {
  holdId?: string | null;
  settlementRecordId?: string | null;
  status?: PaymentRefundStatus | null;
}

export interface RefundListParams {
  limit: number;
  offset: number;
}

export interface RefundExecutionResult {
  status: PaymentRefundStatus;
  providerRef?: string | null;
  failureReason?: string | null;
}

export interface RefundStore {
  /** Insert the pending row; returns false when the settlement already has one (replay). */
  insertPending(row: RefundRow): Promise<boolean>;
  bySettlementRecordId(settlementRecordId: string): Promise<RefundRow | null>;
  forSettlement(settlementRecordId: string): Promise<RefundRow[]>;
  byId(id: string): Promise<RefundRow | null>;
  /** Record an execution outcome: status + providerRef/failureReason, attempts + 1. */
  recordResult(id: string, result: RefundExecutionResult): Promise<void>;
  /** Atomically write the immutable audit decision and its refund transition. */
  resolve(id: string, command: RefundResolutionCommand): Promise<RefundResolutionResult>;
  /** Kobo committed to the refund rail for a hold (processing + completed). */
  committedForHold(holdId: string): Promise<number>;
  list(filter: RefundListFilter, params: RefundListParams): Promise<{ items: RefundRow[]; total: number }>;
}

export function refundIdForSettlement(settlementRecordId: string, holdId?: string): string {
  return `refund:${settlementRecordId}${holdId ? `:${holdId}` : ""}`;
}

export function refundResolutionRow(refundId: string, command: RefundResolutionCommand): RefundResolutionRow {
  const { resolution } = command;
  return {
    action: resolution.action,
    status: resolution.action === "accept-provider"
      ? resolution.status
      : resolution.action === "complete-manual" ? "completed" : "failed",
    providerRef: resolution.action === "allow-retry" ? null : resolution.providerRef,
    evidenceRef: resolution.evidenceRef,
    note: resolution.note,
    resolvedBy: command.resolvedBy,
    resolvedAt: command.resolvedAt,
  };
}

export function sameRefundResolution(existing: RefundResolutionRow, expected: RefundResolutionRow): boolean {
  return existing.action === expected.action
    && existing.status === expected.status
    && existing.providerRef === expected.providerRef
    && existing.evidenceRef === expected.evidenceRef
    && existing.note === expected.note
    && existing.resolvedBy === expected.resolvedBy;
}

export function isRefundResolutionStateValid(status: PaymentRefundStatus, action: PaymentRefundResolution["action"]): boolean {
  return action === "complete-manual" ? status === "refund-manual" : status === "refund-review";
}

function resolutionView(row: RefundResolutionRow): PaymentRefundResolutionView {
  return { ...row, resolvedAt: row.resolvedAt.getTime() };
}

/** Row → wire view (epoch-millisecond timestamps, packages/proto convention). */
export function refundView(row: RefundRow): PaymentRefundView {
  return {
    id: row.id,
    holdId: row.holdId,
    settlementRecordId: row.settlementRecordId,
    amountKobo: row.amountKobo,
    status: row.status,
    providerRef: row.providerRef,
    failureReason: row.failureReason,
    attempts: row.attempts,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    resolution: row.resolution ? resolutionView(row.resolution) : null,
  };
}

/** Durable failure prefixes that mean a previous provider outcome is not known. */
function isAmbiguousRefundFailure(failureReason: string | null): boolean {
  if (!failureReason) return false;
  return failureReason.startsWith("provider-unreachable")
    || failureReason.startsWith("provider-response-unparseable")
    || failureReason.startsWith("provider-response-missing-refund")
    || (failureReason.startsWith("reconciliation-") && !failureReason.startsWith("reconciliation-conflict"));
}

/**
 * Consume one payment.refund-requested. `gateway` is null when no collection
 * provider is configured (the stub dispatcher) — refunds then fail honestly
 * and retry into the DLQ, same posture as dispatches.
 */
export async function handleRefundRequested(
  holds: HoldStore,
  refunds: RefundStore,
  gateway: ChargeGateway | null,
  message: QueueMessageLike,
  value: PaymentRefundRequested,
  notify?: PaymentNotificationSink,
): Promise<void> {
  const existingRows = await refunds.forSettlement(value.settlementRecordId);
  const runHolds = await holds.byRun(value.runId);
  if (runHolds.length === 0) {
    console.error(JSON.stringify({
      event: "payment.refund_no_hold",
      settlementRecordId: value.settlementRecordId,
      runId: value.runId,
      amountKobo: value.amountKobo,
      ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
    }));
    message.ack();
    return;
  }

  let remainingKobo = value.amountKobo;
  const planned = runHolds.map((hold) => {
    const amountKobo = Math.min(remainingKobo, hold.amountKobo);
    remainingKobo -= amountKobo;
    return { hold, amountKobo };
  });
  if (remainingKobo > 0) planned[0] = { ...planned[0]!, amountKobo: planned[0]!.amountKobo + remainingKobo };

  // One durable row per contributing hold. A retry skips committed rows, so a
  // partial multi-hold failure can never repeat an earlier provider refund.
  for (const { hold, amountKobo } of planned) {
    if (amountKobo <= 0) continue;
    const refundId = refundIdForSettlement(value.settlementRecordId, runHolds.length > 1 ? hold.id : undefined);
    const existing = existingRows.find((candidate) => candidate.id === refundId);
    if (existing && (existing.holdId !== hold.id || existing.settlementRecordId !== value.settlementRecordId || existing.amountKobo !== amountKobo)) {
      throw new Error(`idempotency conflict: refund ${refundId} does not match the durable refund request`);
    }
    if (existing && existing.status !== "pending" && existing.status !== "failed") continue;
    const row: RefundRow = existing ?? {
      id: refundId,
      holdId: hold.id,
      settlementRecordId: value.settlementRecordId,
      amountKobo,
      status: "pending",
      providerRef: null,
      failureReason: null,
      attempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      resolution: null,
    };
    if (!existing) await refunds.insertPending(row);

    const emit = async (status: string): Promise<void> => {
      if (!notify) return;
      await notify(paymentNotification({
        sourceEventId: `payment.refund:${row.id}:${status}:${row.attempts + 1}`,
        sourceEventType: "payment.refund-updated",
        recipientId: value.buyerId,
        title: status === "failed" ? "Refund failed" : "Refund updated",
        body: `Your refund is ${status}.`,
        runId: value.runId,
        cartId: hold.cartId,
        status,
      }));
    };
    const fail = async (failureReason: string): Promise<void> => {
      await refunds.recordResult(row.id, { status: "failed", failureReason });
      await emit("failed");
      console.error(JSON.stringify({
        event: "payment.refund_failed",
        refundId: row.id,
        failureReason,
        ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
      }));
      message.retry({ delaySeconds: retryDelaySeconds(row.attempts + 1) });
    };

    if (amountKobo > hold.amountKobo) {
      await fail(`refund-exceeds-hold: ${value.amountKobo} kobo against ${runHolds.reduce((sum, candidate) => sum + candidate.amountKobo, 0)} kobo in holds`);
      return;
    }
    if (gateway === null) {
      if (existing?.status === "failed" && isAmbiguousRefundFailure(existing.failureReason)) {
        // Preserve the ambiguity marker so a later configured worker reconciles
        // instead of treating this as a definite collection-unavailable failure.
        message.retry({ delaySeconds: retryDelaySeconds(row.attempts + 1) });
        return;
      }
      await fail("collection-unavailable: no charge gateway is configured on this worker");
      return;
    }
    if (!gateway.supportsRefund(hold.paymentMethod)) {
      await refunds.recordResult(row.id, {
        status: "refund-manual",
        failureReason: `no API refund rail for payment method "${hold.paymentMethod}"`,
      });
      await emit("refund-manual");
      console.error(JSON.stringify({
        event: "payment.refund_manual",
        refundId: row.id,
        paymentMethod: hold.paymentMethod,
        ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
      }));
      continue;
    }

    const comments = `Buyer refund ${value.settlementRecordId}`;
    if (existing?.status === "failed" && isAmbiguousRefundFailure(existing.failureReason)) {
      const reconciliation = await gateway.reconcileRefund({
        providerTxId: hold.providerTxId,
        amountKobo,
        comments,
      });
      if (reconciliation.status === "indeterminate") {
        await fail(reconciliation.failureReason);
        return;
      }
      if (reconciliation.status === "conflict") {
        await refunds.recordResult(row.id, {
          status: "refund-review",
          providerRef: null,
          failureReason: reconciliation.failureReason,
        });
        await emit("refund-review");
        console.error(JSON.stringify({
          event: "payment.refund_review",
          refundId: row.id,
          failureReason: reconciliation.failureReason,
          ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
        }));
        continue;
      }
      if (reconciliation.status === "found") {
        await refunds.recordResult(row.id, {
          status: reconciliation.refund.status,
          providerRef: reconciliation.refund.providerRef,
          failureReason: null,
        });
        await emit(reconciliation.refund.status);
        const committed = await refunds.committedForHold(hold.id);
        await holds.setStatus(hold.id, committed >= hold.amountKobo ? "refunded" : "partially-refunded");
        continue;
      }
      // not-found proves no accepted refund exists; exactly one new POST may proceed.
    }

    const result = await gateway.refundCharge(
      hold.providerTxId,
      amountKobo === hold.amountKobo ? null : amountKobo,
      comments,
    );
    const persistedStatus = result.status === "indeterminate" ? "failed" : result.status;
    await refunds.recordResult(row.id, {
      status: persistedStatus,
      providerRef: result.providerRef ?? null,
      failureReason: result.failureReason ?? null,
    });
    await emit(persistedStatus);
    if (result.status === "failed" || result.status === "indeterminate") {
      console.error(JSON.stringify({
        event: "payment.refund_failed",
        refundId: row.id,
        failureReason: result.failureReason ?? "unknown",
        ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
      }));
      message.retry({ delaySeconds: retryDelaySeconds(row.attempts + 1) });
      return;
    }
    const committed = await refunds.committedForHold(hold.id);
    await holds.setStatus(hold.id, committed >= hold.amountKobo ? "refunded" : "partially-refunded");
  }
  message.ack();
}

type Database = ReturnType<typeof createDatabase>["db"];
type PersistedRefundRow = Omit<RefundRow, "resolution">;
type RefundSelection = { refund: PersistedRefundRow; resolution: RefundResolutionRow | null };

function joinedRefund(row: RefundSelection): RefundRow {
  return { ...row.refund, resolution: row.resolution };
}

/** Postgres-backed store over the payment_refunds table (ADR-0011). */
export class DrizzleRefundStore implements RefundStore {
  constructor(private readonly db: Database) {}

  async insertPending(row: RefundRow): Promise<boolean> {
    const { resolution: _resolution, ...values } = row;
    const inserted = await this.db
      .insert(paymentRefunds)
      .values(values)
      .onConflictDoNothing({ target: [paymentRefunds.settlementRecordId, paymentRefunds.holdId] })
      .returning({ id: paymentRefunds.id });
    return inserted.length > 0;
  }

  async bySettlementRecordId(settlementRecordId: string): Promise<RefundRow | null> {
    const rows = await this.db
      .select({ refund: paymentRefunds, resolution: paymentRefundResolutions })
      .from(paymentRefunds)
      .leftJoin(paymentRefundResolutions, eq(paymentRefunds.id, paymentRefundResolutions.refundId))
      .where(eq(paymentRefunds.settlementRecordId, settlementRecordId))
      .limit(1);
    return rows[0] ? joinedRefund(rows[0] as RefundSelection) : null;
  }

  async forSettlement(settlementRecordId: string): Promise<RefundRow[]> {
    const rows = await this.db
      .select({ refund: paymentRefunds, resolution: paymentRefundResolutions })
      .from(paymentRefunds)
      .leftJoin(paymentRefundResolutions, eq(paymentRefunds.id, paymentRefundResolutions.refundId))
      .where(eq(paymentRefunds.settlementRecordId, settlementRecordId));
    return rows.map((row) => joinedRefund(row as RefundSelection));
  }

  async byId(id: string): Promise<RefundRow | null> {
    const rows = await this.db
      .select({ refund: paymentRefunds, resolution: paymentRefundResolutions })
      .from(paymentRefunds)
      .leftJoin(paymentRefundResolutions, eq(paymentRefunds.id, paymentRefundResolutions.refundId))
      .where(eq(paymentRefunds.id, id))
      .limit(1);
    return rows[0] ? joinedRefund(rows[0] as RefundSelection) : null;
  }

  async recordResult(id: string, result: RefundExecutionResult): Promise<void> {
    await this.db
      .update(paymentRefunds)
      .set({
        status: result.status,
        ...(result.providerRef !== undefined ? { providerRef: result.providerRef } : {}),
        ...(result.failureReason !== undefined ? { failureReason: result.failureReason } : {}),
        attempts: sql`${paymentRefunds.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(paymentRefunds.id, id));
  }

  async resolve(id: string, command: RefundResolutionCommand): Promise<RefundResolutionResult> {
    return this.db.transaction(async (tx) => {
      // The parent row lock serializes decisions for one refund. In particular,
      // a concurrent different fingerprint cannot both pass the audit check.
      const refunds = await tx.select().from(paymentRefunds).where(eq(paymentRefunds.id, id)).limit(1).for("update");
      const persisted = refunds[0] as PersistedRefundRow | undefined;
      if (!persisted) return { outcome: "not-found", refund: null };

      const audits = await tx
        .select()
        .from(paymentRefundResolutions)
        .where(eq(paymentRefundResolutions.refundId, id))
        .limit(1);
      const existingResolution = (audits[0] as RefundResolutionRow | undefined) ?? null;
      const current = { ...persisted, resolution: existingResolution };
      const resolution = refundResolutionRow(id, command);
      // Replay/conflict deliberately precede state validation: a retry decision
      // remains replayable after its refund has advanced from review to failed.
      if (existingResolution) {
        return sameRefundResolution(existingResolution, resolution)
          ? { outcome: "replayed", refund: current }
          : { outcome: "conflict", refund: current };
      }
      if (!isRefundResolutionStateValid(current.status, resolution.action)) {
        return { outcome: "invalid-state", refund: current };
      }

      await tx.insert(paymentRefundResolutions).values({ refundId: id, ...resolution });
      const updated = await tx
        .update(paymentRefunds)
        .set({
          status: resolution.status,
          ...(resolution.action !== "allow-retry"
            ? { providerRef: resolution.providerRef, failureReason: null }
            : {}),
          updatedAt: command.resolvedAt,
        })
        .where(eq(paymentRefunds.id, id))
        .returning();
      const refund = updated[0] as PersistedRefundRow | undefined;
      if (!refund) throw new Error(`refund ${id} disappeared during resolution`);
      if (resolution.action !== "allow-retry") {
        const holdRows = await tx.select().from(paymentHolds).where(eq(paymentHolds.id, refund.holdId)).limit(1).for("update");
        const hold = holdRows[0] as HoldRow | undefined;
        if (!hold) throw new Error(`hold ${refund.holdId} is unknown during refund resolution`);
        const totals = await tx
          .select({ total: sql<number>`coalesce(sum(${paymentRefunds.amountKobo}), 0)::int` })
          .from(paymentRefunds)
          .where(and(eq(paymentRefunds.holdId, hold.id), inArray(paymentRefunds.status, ["processing", "completed"])));
        const committed = totals[0]?.total ?? 0;
        await tx
          .update(paymentHolds)
          .set({ status: committed >= hold.amountKobo ? "refunded" : "partially-refunded", updatedAt: command.resolvedAt })
          .where(eq(paymentHolds.id, hold.id));
      }
      return { outcome: "applied", refund: { ...refund, resolution } };
    });
  }

  async committedForHold(holdId: string): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`coalesce(sum(${paymentRefunds.amountKobo}), 0)::int` })
      .from(paymentRefunds)
      .where(and(eq(paymentRefunds.holdId, holdId), inArray(paymentRefunds.status, ["processing", "completed"])));
    return rows[0]?.total ?? 0;
  }

  async list(filter: RefundListFilter, params: RefundListParams): Promise<{ items: RefundRow[]; total: number }> {
    const conditions: SQL[] = [];
    if (filter.holdId) conditions.push(eq(paymentRefunds.holdId, filter.holdId));
    if (filter.settlementRecordId) {
      conditions.push(eq(paymentRefunds.settlementRecordId, filter.settlementRecordId));
    }
    if (filter.status) conditions.push(eq(paymentRefunds.status, filter.status));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const items = await this.db
      .select({ refund: paymentRefunds, resolution: paymentRefundResolutions })
      .from(paymentRefunds)
      .leftJoin(paymentRefundResolutions, eq(paymentRefunds.id, paymentRefundResolutions.refundId))
      .where(where)
      .orderBy(desc(paymentRefunds.createdAt))
      .limit(params.limit)
      .offset(params.offset);
    const totals = await this.db.select({ count: sql<number>`count(*)::int` }).from(paymentRefunds).where(where);
    return { items: items.map((row) => joinedRefund(row as RefundSelection)), total: totals[0]?.count ?? 0 };
  }
}
