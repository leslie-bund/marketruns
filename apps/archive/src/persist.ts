import type { PgTransaction } from "drizzle-orm/pg-core";

/** The archive consumer always runs inside db.transaction(...). */
export type ArchiveTx = PgTransaction<any, any, any>;
import type { SettlementOutcome } from "@market-runs/domain";
import type {
  CartRetired,
  ProductRetired,
  RunRetired,
  RunStarted,
  SettlementReleased,
} from "@market-runs/proto";
import { and, eq, isNull } from "drizzle-orm";
import {
  archivedProducts,
  disputes,
  ledgerEntries,
  liveRuns,
  runsArchive,
  settlementRecords,
  type SettlementInputSnapshot,
  type SettlementOutcomeSnapshot,
} from "../../../infra/drizzle/schema.js";
import { settlementLegs } from "./settlement-legs.js";

/**
 * Archive persistence: retirement events → durable rows (ADR-0010/0011).
 * Every id is deterministic and every insert is onConflictDoNothing, so
 * queue redelivery is a no-op replay, never a duplicate row.
 */

export const CART_SNAPSHOT_PREFIX = "snapshots/carts/";

export function runStartedRow(message: RunStarted) {
  return {
    runId: message.runId,
    market: message.market,
    status: message.status,
    runnerId: message.runnerId,
    buyerId: message.buyerId,
    startedAt: new Date(message.startedAt),
    retiredAt: null as Date | null,
    stopCount: message.stopCount,
    storeIds: message.storeIds,
  };
}

export function runRetiredRow(message: RunRetired) {
  return {
    id: message.runId,
    cartId: message.cartId,
    marketId: message.market,
    buyerId: message.buyerId,
    runnerId: message.runnerId,
    status: message.status,
    delivery: message.delivery,
    floorRateKobo: message.floorRateKobo,
    startedAt: null as Date | null,
    finalDeliveryAt: null as Date | null,
    closedAt: new Date(message.closedAt),
  };
}

export function settlementRecordRow(message: SettlementReleased) {
  const outcome: SettlementOutcomeSnapshot = {
    sellers: message.sellers,
    runnerKobo: message.runnerKobo,
    platformKobo: message.platformKobo,
    buyerRefundKobo: message.buyerRefundKobo,
    platformLossKobo: message.platformLossKobo,
  };
  const goodsTotalKobo = message.inputs.sellers.reduce((sum, seller) => sum + seller.amountKobo, 0);
  return {
    id: settlementRecordId(message.runId),
    runId: message.runId,
    mode: message.mode,
    goodsTotalKobo,
    runnerKobo: message.runnerKobo,
    platformKobo: message.platformKobo,
    buyerRefundKobo: message.buyerRefundKobo,
    platformLossKobo: message.platformLossKobo,
    inputs: message.inputs as SettlementInputSnapshot,
    outcome,
    releasedAt: new Date(message.releasedAt),
  };
}

export function settlementRecordId(runId: string): string {
  return `${runId}:settlement`;
}

/** Deterministic dispute id — one open dispute per run (redelivery replays, never duplicates). */
export function disputeId(runId: string): string {
  return `${runId}:dispute`;
}

/**
 * Map a run.retired dispute block (ADR-0019) onto a disputes row, or null when
 * the run closed undisputed. Status starts "open" (the table's unresolved
 * status; ops resolves later via settle). `ambiguous` stays at its column
 * default (false) until the evidence layer rules; a NULL raiser (timer close)
 * is recorded as "unknown" because the column is NOT NULL.
 */
export function disputeRow(message: RunRetired) {
  if (!message.dispute) return null;
  return {
    id: disputeId(message.runId),
    runId: message.runId,
    raisedByParticipantId: message.dispute.raisedByParticipantId ?? "unknown",
    reason: message.dispute.reason,
    evidenceRefs: message.dispute.evidenceRefs,
    status: "open",
    createdAt: new Date(message.closedAt),
  };
}

export interface LedgerRow {
  id: string;
  settlementRecordId: string;
  account: string;
  partyId: string | null;
  debitKobo: number;
  creditKobo: number;
  memo: string;
}

export function ledgerRows(message: SettlementReleased): LedgerRow[] {
  const recordId = settlementRecordId(message.runId);
  return settlementLegs(
    {
      sellers: message.sellers,
      runnerKobo: message.runnerKobo,
      platformKobo: message.platformKobo,
      buyerRefundKobo: message.buyerRefundKobo,
      platformLossKobo: message.platformLossKobo,
    } satisfies SettlementOutcome,
    { buyerId: message.buyerId, runnerId: message.runnerId },
  ).map((leg, index) => ({
    id: `${recordId}:leg:${index}`,
    settlementRecordId: recordId,
    account: leg.account,
    partyId: leg.partyId ?? null,
    debitKobo: leg.debitKobo,
    creditKobo: leg.creditKobo,
    memo: leg.memo,
  }));
}

const RETIREMENT_REASON_MAP: Record<ProductRetired["reason"], string> = {
  sold: "accepted",
  expired: "expired",
  withdrawn: "withdrawn",
  "cart-retired": "cart_expired",
};

export function productRetiredRow(message: ProductRetired) {
  return {
    id: message.productId,
    intentId: message.intentId,
    cartId: null as string | null,
    storeId: message.snapshot.sellerName,
    marketId: message.market ?? "unknown",
    buyerId: message.buyerId ?? null,
    finalPriceKobo: message.snapshot.priceKobo,
    quantity: message.snapshot.quantity,
    retirementReason: RETIREMENT_REASON_MAP[message.reason],
    finalState: message.snapshot,
    retiredAt: new Date(message.retiredAt),
  };
}

export function cartSnapshotKey(message: CartRetired): string {
  return `${CART_SNAPSHOT_PREFIX}${message.cartId}/${message.retiredAt}.json`;
}

/** Persist one archive message inside the queue batch's transaction. */
export async function persistMessage(
  tx: ArchiveTx,
  message: RunStarted | RunRetired | SettlementReleased | ProductRetired | CartRetired,
  bucket?: R2Bucket,
): Promise<void> {
  switch (message.type) {
    case "run.started": {
      // Live-run index upsert: queue redelivery replays the same row, and a
      // replayed start never clears retired_at (the update set omits it).
      const row = runStartedRow(message);
      await tx
        .insert(liveRuns)
        .values(row)
        .onConflictDoUpdate({
          target: liveRuns.runId,
          set: {
            market: row.market,
            status: row.status,
            runnerId: row.runnerId,
            buyerId: row.buyerId,
            startedAt: row.startedAt,
            stopCount: row.stopCount,
            storeIds: row.storeIds,
            updatedAt: new Date(),
          },
        });
      return;
    }
    case "run.retired": {
      // Inserted before settlement.released in the same batch (queue order),
      // satisfying the settlement_records → runs_archive FK.
      await tx.insert(runsArchive).values(runRetiredRow(message)).onConflictDoNothing();
      // Dispute context rides run.retired (ADR-0019): write the disputes row
      // AFTER the runs_archive insert — disputes.run_id FKs to it, so this
      // ordering is part of the same rank rule (run.retired before
      // settlement.released). Deterministic id + onConflictDoNothing: queue
      // redelivery is a no-op replay.
      const dispute = disputeRow(message);
      if (dispute) {
        await tx.insert(disputes).values(dispute).onConflictDoNothing();
      }
      // Retire the live-run index entry with the final status.
      await tx
        .update(liveRuns)
        .set({ status: message.status, retiredAt: new Date(message.closedAt), updatedAt: new Date() })
        .where(eq(liveRuns.runId, message.runId));
      return;
    }
    case "settlement.released": {
      await tx.insert(settlementRecords).values(settlementRecordRow(message)).onConflictDoNothing();
      const recordId = settlementRecordId(message.runId);
      const resolvedAt = new Date(message.releasedAt);
      const ambiguous = message.mode === "disputed" ? (message.inputs.dispute?.ambiguous ?? true) : false;
      const resolution = {
        settlementRecordId: recordId,
        ambiguous,
        absorbedLossKobo: message.platformLossKobo,
        status: "resolved",
        resolvedAt,
      };
      const resolvedDisputes = await tx
        .update(disputes)
        .set(resolution)
        .where(eq(disputes.runId, message.runId))
        .returning({ id: disputes.id });
      if (message.mode === "disputed" && resolvedDisputes.length === 0) {
        await tx.insert(disputes).values({
          id: disputeId(message.runId),
          runId: message.runId,
          ...resolution,
          raisedByParticipantId: "unknown",
          reason: "",
          evidenceRefs: [],
          createdAt: resolvedAt,
        }).onConflictDoNothing();
      }
      const rows = ledgerRows(message);
      if (rows.length > 0) {
        await tx.insert(ledgerEntries).values(rows).onConflictDoNothing();
      }
      // Belt-and-braces retirement: if run.retired was never seen, payment
      // release still closes out the live-run index entry.
      await tx
        .update(liveRuns)
        .set({ retiredAt: new Date(message.releasedAt), updatedAt: new Date() })
        .where(and(eq(liveRuns.runId, message.runId), isNull(liveRuns.retiredAt)));
      return;
    }
    case "product.retired":
      await tx.insert(archivedProducts).values(productRetiredRow(message)).onConflictDoNothing();
      return;
    case "cart.retired":
      // No carts table: the full snapshot is analytics-grade and lives in R2
      // (ADR-0010: retirement snapshots → Postgres/R2). Best-effort: a failed
      // put is logged and acked — Postgres rows remain the system of record.
      if (!bucket) {
        console.error(
          JSON.stringify({
            event: "archive.snapshot_skipped",
            reason: "no R2 bucket bound",
            cartId: message.cartId,
            ...(message.requestId !== undefined ? { requestId: message.requestId } : {}),
          }),
        );
        return;
      }
      try {
        await bucket.put(cartSnapshotKey(message), JSON.stringify(message));
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "archive.snapshot_failed",
            cartId: message.cartId,
            ...(message.requestId !== undefined ? { requestId: message.requestId } : {}),
            error: String(error),
          }),
        );
      }
      return;
  }
}
