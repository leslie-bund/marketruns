import { and, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { DispatchAccount, PaymentDispatchStatus, PaymentDispatchView } from "@market-runs/proto";
import type { PaymentDispatchRequested } from "./messages.js";
import type { DispatchTransferResult } from "./dispatcher.js";
import { providerReferenceFor } from "./provider-reference.js";
import { paymentDispatches } from "../../../infra/drizzle/schema.js";
import type { createDatabase } from "./db.js";

/**
 * Payment dispatch persistence: payment-dispatch queue messages → durable
 * rows (ADR-0010/0011). Every id and idempotency key is deterministic and
 * inserts are onConflictDoNothing, so at-least-once queue redelivery is a
 * no-op replay, never a duplicate row or a double payout.
 *
 * The narrow DispatchStore interface exists so the consumer/replay logic is
 * testable without Postgres (the in-memory test double lives in test/);
 * DrizzleDispatchStore is the only implementation that runs in the worker.
 */

/** One durable dispatch row, as persisted (dates as Date, wire converts to epoch ms). */
export interface DispatchRow {
  id: string;
  idempotencyKey: string;
  /**
   * Provider-facing reference alias (ADR-0024 amendment). The full
   * idempotencyKey remains canonical; this is the short, deterministic value
   * sent to the provider and used for webhook/reconcile matching.
   */
  providerReference: string | null;
  settlementRecordId: string;
  runId: string;
  market: string;
  account: DispatchAccount;
  partyId: string;
  amountKobo: number;
  memo: string;
  status: PaymentDispatchStatus;
  providerRef: string | null;
  failureReason: string | null;
  /** Failed rows: true = queue retry may recover; false = deterministic, ops replay only. */
  failureRetryable: boolean;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DispatchListFilter {
  runId?: string | null;
  status?: PaymentDispatchStatus | null;
}

export interface DispatchListParams {
  limit: number;
  offset: number;
}

export interface DispatchStore {
  /** Insert the pending row; returns false when the idempotency key already exists (replay). */
  insertPending(row: DispatchRow): Promise<boolean>;
  byIdempotencyKey(idempotencyKey: string): Promise<DispatchRow | null>;
  byId(id: string): Promise<DispatchRow | null>;
  byProviderRef(providerRef: string): Promise<DispatchRow | null>;
  /** Match an inbound provider reference alias (ADR-0024 amendment). */
  byProviderReference(providerReference: string): Promise<DispatchRow | null>;
  /** Every durable dispatch row for a run, without pagination (hold finalization guard). */
  byRun(runId: string): Promise<DispatchRow[]>;
  /** Record a dispatcher outcome: status + providerRef/failureReason, attempts + 1. */
  recordResult(id: string, result: DispatchTransferResult): Promise<void>;
  /**
   * Record an asynchronous status outcome (webhook / provider sync): status +
   * failureReason, WITHOUT bumping attempts — no transfer was re-executed.
   */
  recordStatus(id: string, update: DispatchStatusUpdate): Promise<void>;
  /** Rows in one of `statuses` whose updatedAt is older than `updatedBefore` (stale-scan for sync). */
  listStale(statuses: PaymentDispatchStatus[], updatedBefore: Date, limit: number): Promise<DispatchRow[]>;
  list(filter: DispatchListFilter, params: DispatchListParams): Promise<{ items: DispatchRow[]; total: number }>;
}

/** A status transition learned asynchronously (provider webhook or sync poll). */
export interface DispatchStatusUpdate {
  status: PaymentDispatchStatus;
  failureReason?: string | null;
  /** Defaults to false for a failed status (provider-terminal), true otherwise. */
  retryable?: boolean;
}

/** Deterministic per-leg coordinates (the edge emits legs in settlement order). */
export function dispatchRowId(message: PaymentDispatchRequested, legIndex: number): string {
  return `${message.runId}:dispatch:${legIndex}`;
}

export function legIdempotencyKey(message: PaymentDispatchRequested, legIndex: number): string {
  return `${message.idempotencyKey}:leg:${legIndex}`;
}

/** Map one dispatch leg of a payment.dispatch-requested message to its pending row. */
export function dispatchRow(message: PaymentDispatchRequested, legIndex: number): DispatchRow {
  const leg = message.legs[legIndex];
  if (!leg) throw new Error(`leg ${legIndex} is out of range`);
  return {
    id: dispatchRowId(message, legIndex),
    idempotencyKey: legIdempotencyKey(message, legIndex),
    providerReference: null,
    settlementRecordId: message.settlementRecordId,
    runId: message.runId,
    market: message.market,
    account: leg.account,
    partyId: leg.partyId,
    amountKobo: leg.amountKobo,
    memo: leg.memo,
    status: "pending",
    providerRef: null,
    failureReason: null,
    failureRetryable: true,
    attempts: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * The pending row with its deterministic provider alias already attached.
 * The consumer inserts this before the first send, so a webhook that races
 * ahead of the HTTP response can match by providerReference.
 */
export async function dispatchRowWithReference(
  message: PaymentDispatchRequested,
  legIndex: number,
): Promise<DispatchRow> {
  const row = dispatchRow(message, legIndex);
  return { ...row, providerReference: await providerReferenceFor(row.idempotencyKey) };
}

/** Row → wire view (epoch-millisecond timestamps, packages/proto convention). */
export function dispatchView(row: DispatchRow): PaymentDispatchView {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    settlementRecordId: row.settlementRecordId,
    runId: row.runId,
    market: row.market,
    account: row.account,
    partyId: row.partyId,
    amountKobo: row.amountKobo,
    memo: row.memo,
    status: row.status,
    providerRef: row.providerRef,
    failureReason: row.failureReason,
    attempts: row.attempts,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

type Database = ReturnType<typeof createDatabase>["db"];

/** Postgres-backed store over the payment_dispatches table (ADR-0011). */
export class DrizzleDispatchStore implements DispatchStore {
  constructor(private readonly db: Database) {}

  async insertPending(row: DispatchRow): Promise<boolean> {
    const inserted = await this.db
      .insert(paymentDispatches)
      .values(row)
      .onConflictDoNothing({ target: paymentDispatches.idempotencyKey })
      .returning({ id: paymentDispatches.id });
    return inserted.length > 0;
  }

  async byIdempotencyKey(idempotencyKey: string): Promise<DispatchRow | null> {
    const rows = await this.db
      .select()
      .from(paymentDispatches)
      .where(eq(paymentDispatches.idempotencyKey, idempotencyKey))
      .limit(1);
    return (rows[0] as DispatchRow | undefined) ?? null;
  }

  async byId(id: string): Promise<DispatchRow | null> {
    const rows = await this.db.select().from(paymentDispatches).where(eq(paymentDispatches.id, id)).limit(1);
    return (rows[0] as DispatchRow | undefined) ?? null;
  }

  async byProviderRef(providerRef: string): Promise<DispatchRow | null> {
    const rows = await this.db
      .select()
      .from(paymentDispatches)
      .where(eq(paymentDispatches.providerRef, providerRef))
      .limit(1);
    return (rows[0] as DispatchRow | undefined) ?? null;
  }

  async byProviderReference(providerReference: string): Promise<DispatchRow | null> {
    const rows = await this.db
      .select()
      .from(paymentDispatches)
      .where(eq(paymentDispatches.providerReference, providerReference))
      .limit(1);
    return (rows[0] as DispatchRow | undefined) ?? null;
  }

  async byRun(runId: string): Promise<DispatchRow[]> {
    const rows = await this.db.select().from(paymentDispatches).where(eq(paymentDispatches.runId, runId));
    return rows as DispatchRow[];
  }

  async recordResult(id: string, result: DispatchTransferResult): Promise<void> {
    await this.db
      .update(paymentDispatches)
      .set({
        status: result.status,
        // The dispatcher returns the alias it actually sent. Persist it for
        // legacy rows that were created before the alias column existed; new
        // rows already carry it from insert. Never clear an existing alias.
        ...(result.providerReference !== undefined ? { providerReference: result.providerReference } : {}),
        providerRef: result.providerRef ?? null,
        failureReason: result.failureReason ?? null,
        // A successful retry clears the terminal flag; a failed result defaults
        // to retryable for backward compatibility with dispatchers that do not
        // classify their failures yet.
        failureRetryable: result.status === "failed" ? result.retryable !== false : true,
        attempts: sql`${paymentDispatches.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(paymentDispatches.id, id));
  }

  async recordStatus(id: string, update: DispatchStatusUpdate): Promise<void> {
    await this.db
      .update(paymentDispatches)
      .set({
        status: update.status,
        ...(update.failureReason !== undefined ? { failureReason: update.failureReason } : {}),
        // Provider webhooks/sync report terminal outcomes; a failed transfer
        // there is not a candidate for the queue retry path.
        failureRetryable: update.retryable ?? (update.status !== "failed"),
        updatedAt: new Date(),
      })
      .where(eq(paymentDispatches.id, id));
  }

  async listStale(statuses: PaymentDispatchStatus[], updatedBefore: Date, limit: number): Promise<DispatchRow[]> {
    const rows = await this.db
      .select()
      .from(paymentDispatches)
      .where(and(inArray(paymentDispatches.status, statuses), lt(paymentDispatches.updatedAt, updatedBefore)))
      .orderBy(paymentDispatches.updatedAt)
      .limit(limit);
    return rows as DispatchRow[];
  }

  async list(filter: DispatchListFilter, params: DispatchListParams): Promise<{ items: DispatchRow[]; total: number }> {
    const conditions: SQL[] = [];
    if (filter.runId) conditions.push(eq(paymentDispatches.runId, filter.runId));
    if (filter.status) conditions.push(eq(paymentDispatches.status, filter.status));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const items = await this.db
      .select()
      .from(paymentDispatches)
      .where(where)
      .orderBy(desc(paymentDispatches.createdAt))
      .limit(params.limit)
      .offset(params.offset);
    const totals = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(paymentDispatches)
      .where(where);
    return { items: items as DispatchRow[], total: totals[0]?.count ?? 0 };
  }
}
