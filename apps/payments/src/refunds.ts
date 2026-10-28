import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PaymentRefundStatus, PaymentRefundView } from "@market-runs/proto";
import type { PaymentRefundRequested } from "@market-runs/proto";
import { paymentRefunds } from "../../../infra/drizzle/schema.js";
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
}

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
  /** Kobo committed to the refund rail for a hold (processing + completed). */
  committedForHold(holdId: string): Promise<number>;
  list(filter: RefundListFilter, params: RefundListParams): Promise<{ items: RefundRow[]; total: number }>;
}

export function refundIdForSettlement(settlementRecordId: string, holdId?: string): string {
  return `refund:${settlementRecordId}${holdId ? `:${holdId}` : ""}`;
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
  };
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

    const result = await gateway.refundCharge(
      hold.providerTxId,
      amountKobo === hold.amountKobo ? null : amountKobo,
      `Buyer refund ${value.settlementRecordId}`,
    );
    await refunds.recordResult(row.id, {
      status: result.status,
      providerRef: result.providerRef ?? null,
      failureReason: result.failureReason ?? null,
    });
    await emit(result.status);
    if (result.status === "failed") {
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

/** Postgres-backed store over the payment_refunds table (ADR-0011). */
export class DrizzleRefundStore implements RefundStore {
  constructor(private readonly db: Database) {}

  async insertPending(row: RefundRow): Promise<boolean> {
    const inserted = await this.db
      .insert(paymentRefunds)
      .values(row)
      .onConflictDoNothing({ target: [paymentRefunds.settlementRecordId, paymentRefunds.holdId] })
      .returning({ id: paymentRefunds.id });
    return inserted.length > 0;
  }

  async bySettlementRecordId(settlementRecordId: string): Promise<RefundRow | null> {
    const rows = await this.db
      .select()
      .from(paymentRefunds)
      .where(eq(paymentRefunds.settlementRecordId, settlementRecordId))
      .limit(1);
    return (rows[0] as RefundRow | undefined) ?? null;
  }

  async forSettlement(settlementRecordId: string): Promise<RefundRow[]> {
    const rows = await this.db.select().from(paymentRefunds).where(eq(paymentRefunds.settlementRecordId, settlementRecordId));
    return rows as RefundRow[];
  }

  async byId(id: string): Promise<RefundRow | null> {
    const rows = await this.db.select().from(paymentRefunds).where(eq(paymentRefunds.id, id)).limit(1);
    return (rows[0] as RefundRow | undefined) ?? null;
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
      .select()
      .from(paymentRefunds)
      .where(where)
      .orderBy(desc(paymentRefunds.createdAt))
      .limit(params.limit)
      .offset(params.offset);
    const totals = await this.db.select({ count: sql<number>`count(*)::int` }).from(paymentRefunds).where(where);
    return { items: items as RefundRow[], total: totals[0]?.count ?? 0 };
  }
}
