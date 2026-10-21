import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { PaymentHoldStatus, PaymentHoldView } from "@market-runs/proto";
import type { PaymentChargeConfirmRequest } from "@market-runs/proto";
import { paymentHolds } from "../../../infra/drizzle/schema.js";
import type { createDatabase } from "./db.js";
import type { ChargeGateway, ChargeVerification } from "./gateway.js";

/**
 * Payment holds: the buyer's collected money, recorded ONLY after server-side
 * verification with the provider (the verify API is truth; client amounts and
 * webhook payloads are hints). The edge gates checkout on a matching hold when
 * PAYMENTS_REQUIRED is on, and the refund rail executes the settlement's
 * buyerRefundKobo leg against the hold bound to the run.
 *
 * Idempotency: hold ids are deterministic (`hold:<txRef>`), tx_ref is a
 * UNIQUE column, and inserts are onConflictDoNothing — a re-confirmation
 * (client retry, webhook racing the confirm endpoint) is a no-op replay that
 * returns the existing hold.
 *
 * Status lifecycle: held → released (the run settled and payout legs
 * dispatched) | partially-refunded → refunded (the refund rail committed
 * refunds covering the hold). "failed" is reserved for holds whose charge
 * verification later proves false — nothing sets it yet; the column is
 * honest about the possibility.
 */

export interface HoldRow {
  id: string;
  txRef: string;
  providerTxId: string;
  cartId: string;
  runId: string | null;
  buyerId: string;
  amountKobo: number;
  paymentMethod: string;
  status: PaymentHoldStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface HoldListFilter {
  buyerId?: string | null;
  runId?: string | null;
  status?: PaymentHoldStatus | null;
}

export interface HoldListParams {
  limit: number;
  offset: number;
}

export type BindRunResult = "bound" | "already-bound" | "conflict" | "missing";

export interface HoldStore {
  /** Insert the hold; returns false when txRef already exists (replay). */
  insertIfAbsent(row: HoldRow): Promise<boolean>;
  byTxRef(txRef: string): Promise<HoldRow | null>;
  byId(id: string): Promise<HoldRow | null>;
  byRunId(runId: string): Promise<HoldRow | null>;
  /** Bind the hold to its run at checkout; idempotent on the same runId. */
  bindRun(id: string, runId: string): Promise<BindRunResult>;
  setStatus(id: string, status: PaymentHoldStatus): Promise<void>;
  /** Transition held → released only; never overwrites a refund state. */
  release(id: string): Promise<void>;
  list(filter: HoldListFilter, params: HoldListParams): Promise<{ items: HoldRow[]; total: number }>;
}

export function holdIdForTxRef(txRef: string): string {
  return `hold:${txRef}`;
}

/** Row → wire view (epoch-millisecond timestamps, packages/proto convention). */
export function holdView(row: HoldRow): PaymentHoldView {
  return {
    id: row.id,
    txRef: row.txRef,
    providerTxId: row.providerTxId,
    cartId: row.cartId,
    runId: row.runId,
    buyerId: row.buyerId,
    amountKobo: row.amountKobo,
    paymentMethod: row.paymentMethod,
    status: row.status,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/* ------------------------------------------------------------------------ */
/* Charge confirmation core — shared by POST /payments/charges/confirm and    */
/* the charge.completed webhook path. Both verify server-side; the confirm    */
/* endpoint additionally cross-checks the client's expected amount.           */
/* ------------------------------------------------------------------------ */

export type ConfirmHoldResult =
  | { kind: "confirmed"; hold: HoldRow; replayed: boolean }
  | { kind: "error"; status: number; error: string; message: string };

function error(status: number, code: string, message: string): ConfirmHoldResult {
  return { kind: "error", status, error: code, message };
}

/**
 * Verify the charge with the provider and place the hold. Idempotent on
 * txRef: an existing hold for the same cart+buyer replays to 200; one for a
 * DIFFERENT cart/buyer is a conflict (a reference is one buyer's money).
 */
export async function confirmHold(
  store: HoldStore,
  gateway: ChargeGateway,
  request: PaymentChargeConfirmRequest,
): Promise<ConfirmHoldResult> {
  if (request.txRef !== undefined) {
    const existing = await store.byTxRef(request.txRef);
    if (existing) {
      if (existing.cartId !== request.cartId || existing.buyerId !== request.buyerId) {
        return error(
          409,
          "hold-conflict",
          `txRef ${request.txRef} already holds ${existing.amountKobo} kobo for cart ${existing.cartId}`,
        );
      }
      return { kind: "confirmed", hold: existing, replayed: true };
    }
  }

  const verification = await gateway.verifyCharge({
    ...(request.txRef !== undefined ? { txRef: request.txRef } : {}),
    ...(request.transactionId !== undefined ? { transactionId: String(request.transactionId) } : {}),
  });
  if (!verification) {
    return error(404, "charge-not-found", "the provider does not know this charge");
  }
  return recordVerifiedHold(store, verification, {
    buyerId: request.buyerId,
    cartId: request.cartId,
    expectedAmountKobo: request.expectedAmountKobo,
    ...(request.txRef !== undefined ? { expectedTxRef: request.txRef } : {}),
  });
}

/**
 * Record a server-verified charge as a hold. `expectedAmountKobo` is the
 * confirm endpoint's client cross-check (exact match — a partial payment is
 * not a hold); the webhook path omits it and trusts the verified amount.
 */
export async function recordVerifiedHold(
  store: HoldStore,
  verification: ChargeVerification,
  context: { buyerId: string; cartId: string; expectedAmountKobo?: number; expectedTxRef?: string },
): Promise<ConfirmHoldResult> {
  if (verification.status !== "successful") {
    return error(409, "charge-not-successful", `charge status is "${verification.status}", not successful`);
  }
  if (verification.currency !== "NGN") {
    return error(409, "currency-mismatch", `charge currency is ${verification.currency || "unknown"}, expected NGN`);
  }
  if (context.expectedTxRef !== undefined && verification.txRef !== context.expectedTxRef) {
    return error(409, "reference-mismatch", "the verified charge carries a different txRef");
  }
  if (context.expectedAmountKobo !== undefined && verification.amountKobo !== context.expectedAmountKobo) {
    return error(
      409,
      "amount-mismatch",
      `verified charge is ${verification.amountKobo} kobo, expected ${context.expectedAmountKobo}`,
    );
  }
  if (verification.txRef === "") {
    return error(409, "reference-missing", "the verified charge carries no txRef");
  }

  const row: HoldRow = {
    id: holdIdForTxRef(verification.txRef),
    txRef: verification.txRef,
    providerTxId: verification.providerTxId,
    cartId: context.cartId,
    runId: null,
    buyerId: context.buyerId,
    amountKobo: verification.amountKobo,
    paymentMethod: verification.paymentMethod,
    status: "held",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const inserted = await store.insertIfAbsent(row);
  if (!inserted) {
    // Race with a concurrent confirm/webhook: the stored row wins.
    const existing = await store.byTxRef(verification.txRef);
    if (existing) return { kind: "confirmed", hold: existing, replayed: true };
    return error(500, "hold-lost", "hold insert conflicted but the row is unreadable");
  }
  return { kind: "confirmed", hold: row, replayed: false };
}

type Database = ReturnType<typeof createDatabase>["db"];

/** Postgres-backed store over the payment_holds table (ADR-0011). */
export class DrizzleHoldStore implements HoldStore {
  constructor(private readonly db: Database) {}

  async insertIfAbsent(row: HoldRow): Promise<boolean> {
    const inserted = await this.db
      .insert(paymentHolds)
      .values(row)
      .onConflictDoNothing({ target: paymentHolds.txRef })
      .returning({ id: paymentHolds.id });
    return inserted.length > 0;
  }

  async byTxRef(txRef: string): Promise<HoldRow | null> {
    const rows = await this.db.select().from(paymentHolds).where(eq(paymentHolds.txRef, txRef)).limit(1);
    return (rows[0] as HoldRow | undefined) ?? null;
  }

  async byId(id: string): Promise<HoldRow | null> {
    const rows = await this.db.select().from(paymentHolds).where(eq(paymentHolds.id, id)).limit(1);
    return (rows[0] as HoldRow | undefined) ?? null;
  }

  async byRunId(runId: string): Promise<HoldRow | null> {
    const rows = await this.db.select().from(paymentHolds).where(eq(paymentHolds.runId, runId)).limit(1);
    return (rows[0] as HoldRow | undefined) ?? null;
  }

  async bindRun(id: string, runId: string): Promise<BindRunResult> {
    const row = await this.byId(id);
    if (!row) return "missing";
    if (row.runId === runId) return "already-bound";
    if (row.runId !== null) return "conflict";
    await this.db.update(paymentHolds).set({ runId, updatedAt: new Date() }).where(eq(paymentHolds.id, id));
    return "bound";
  }

  async setStatus(id: string, status: PaymentHoldStatus): Promise<void> {
    await this.db.update(paymentHolds).set({ status, updatedAt: new Date() }).where(eq(paymentHolds.id, id));
  }

  async release(id: string): Promise<void> {
    await this.db
      .update(paymentHolds)
      .set({ status: "released", updatedAt: new Date() })
      .where(and(eq(paymentHolds.id, id), eq(paymentHolds.status, "held")));
  }

  async list(filter: HoldListFilter, params: HoldListParams): Promise<{ items: HoldRow[]; total: number }> {
    const conditions: SQL[] = [];
    if (filter.buyerId) conditions.push(eq(paymentHolds.buyerId, filter.buyerId));
    if (filter.runId) conditions.push(eq(paymentHolds.runId, filter.runId));
    if (filter.status) conditions.push(eq(paymentHolds.status, filter.status));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const items = await this.db
      .select()
      .from(paymentHolds)
      .where(where)
      .orderBy(desc(paymentHolds.createdAt))
      .limit(params.limit)
      .offset(params.offset);
    const totals = await this.db.select({ count: sql<number>`count(*)::int` }).from(paymentHolds).where(where);
    return { items: items as HoldRow[], total: totals[0]?.count ?? 0 };
  }
}
