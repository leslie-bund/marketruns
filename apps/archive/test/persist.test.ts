import { describe, expect, it } from "vitest";
import { MVP_ABORT_SPLIT } from "@market-runs/domain";
import type { Product, RunRetired, SettlementReleased } from "@market-runs/proto";
import { disputes, runsArchive } from "../../../infra/drizzle/schema.js";
import {
  cartArchiveSnapshot,
  cartRetiredRow,
  cartSnapshotKey,
  disputeRow,
  ledgerRows,
  persistMessage,
  productRetiredRow,
  runRetiredRow,
  runStartedRow,
  settlementRecordId,
  settlementRecordRow,
  type ArchiveTx,
} from "../src/persist.js";

const now = 1_800_000_000_000;

const runRetired: RunRetired = {
  type: "run.retired",
  runId: "run:cart:a",
  cartId: "cart:a",
  market: "Balogun",
  buyerId: "buyer-1",
  runnerId: "runner:internal",
  status: "closed",
  floorRateKobo: 170_000,
  delivery: { kind: "plus-code", plusCode: "6FR5+8X Lagos" },
  stops: [
    {
      sellerName: "Amina's Fresh Store",
      exchangePoint: "Balogun Market, Stall B14",
      shopItems: ["Tomatoes"],
      status: "completed",
    },
  ],
  mode: "completed",
  settlementLegs: [{ sellerId: "Amina's Fresh Store", amountKobo: 148_500 }],
  runnerKobo: 160_000,
  platformKobo: 26_500,
  buyerRefundKobo: 0,
  platformLossKobo: 0,
  closedAt: now,
};

const released: SettlementReleased = {
  type: "settlement.released",
  runId: "run:cart:a",
  buyerId: "buyer-1",
  runnerId: "runner:internal",
  mode: "completed",
  sellers: [{ sellerId: "Amina's Fresh Store", amountKobo: 148_500 }],
  runnerKobo: 160_000,
  platformKobo: 26_500,
  buyerRefundKobo: 0,
  platformLossKobo: 0,
  releasedAt: now,
  inputs: {
    mode: "completed",
    sellers: [{ sellerId: "Amina's Fresh Store", amountKobo: 165_000, stopCompleted: true }],
    deliveryPriceKobo: 170_000,
    deliveryMarginKobo: 10_000,
    goodsCommissionBps: 1_000,
  },
};

const productSnapshot: Product = {
  id: "product-1",
  intentId: "intent-1",
  shopItem: "Tomatoes",
  quantity: 2,
  unit: "kg",
  priceKobo: 165_000,
  sellerName: "Amina's Fresh Store",
  exchangePoint: "Balogun Market, Stall B14",
  expiresAt: now + 30 * 60 * 1000,
  status: "retired",
};

describe("archive row mappings", () => {
  it("maps run.started to a live_runs row with a NULL retiredAt", () => {
    const row = runStartedRow({
      type: "run.started",
      runId: "run:cart:a",
      market: "Balogun",
      status: "assigned",
      runnerId: null,
      buyerId: "buyer-1",
      startedAt: now,
      stopCount: 2,
      storeIds: ["Amina's Fresh Store", "Balogun Spices"],
    });
    expect(row.runId).toBe("run:cart:a");
    expect(row.market).toBe("Balogun");
    expect(row.status).toBe("assigned");
    expect(row.runnerId).toBeNull();
    expect(row.buyerId).toBe("buyer-1");
    expect(row.startedAt).toEqual(new Date(now));
    expect(row.retiredAt).toBeNull();
    expect(row.stopCount).toBe(2);
    expect(row.storeIds).toEqual(["Amina's Fresh Store", "Balogun Spices"]);
  });

  it("maps run.retired to a runs_archive row with durable identities", () => {
    const row = runRetiredRow(runRetired);
    expect(row.id).toBe("run:cart:a");
    expect(row.cartId).toBe("cart:a");
    expect(row.marketId).toBe("Balogun");
    expect(row.buyerId).toBe("buyer-1");
    expect(row.runnerId).toBe("runner:internal");
    expect(row.closedAt).toEqual(new Date(now));
    expect(row.startedAt).toBeNull();
  });

  it("maps settlement.released to a settlement record with verbatim inputs and outcome", () => {
    const row = settlementRecordRow(released);
    expect(row.id).toBe(settlementRecordId("run:cart:a"));
    expect(row.goodsTotalKobo).toBe(165_000);
    expect(row.inputs).toEqual(released.inputs);
    expect(row.outcome.sellers).toEqual(released.sellers);
    expect(row.mode).toBe("completed");
  });

  it("derives balanced, deterministic ledger legs from the released outcome", () => {
    const rows = ledgerRows(released);
    expect(rows.map((row) => row.id)).toEqual([
      "run:cart:a:settlement:leg:0",
      "run:cart:a:settlement:leg:1",
      "run:cart:a:settlement:leg:2",
      "run:cart:a:settlement:leg:3",
    ]);
    const debited = rows.reduce((sum, row) => sum + row.debitKobo, 0);
    const credited = rows.reduce((sum, row) => sum + row.creditKobo, 0);
    expect(debited).toBe(credited);
    expect(rows.find((row) => row.account === "buyer_capture")?.debitKobo).toBe(335_000);
    expect(rows.find((row) => row.account === "runner_payable")?.partyId).toBe("runner:internal");
  });

  it("keeps abort friction legs balanced (ADR-0008: never a full refund)", () => {
    const abortReleased = {
      ...released,
      mode: "aborted" as const,
      sellers: [{ sellerId: "Amina's Fresh Store", amountKobo: 0 }],
      runnerKobo: 32_500,
      platformKobo: 27_000,
      buyerRefundKobo: 275_500,
      inputs: {
        ...released.inputs,
        mode: "aborted" as const,
        sellers: [{ sellerId: "Amina's Fresh Store", amountKobo: 165_000, stopCompleted: false }],
        abortSplit: MVP_ABORT_SPLIT,
      },
    };
    const rows = ledgerRows(abortReleased);
    const debited = rows.reduce((sum, row) => sum + row.debitKobo, 0);
    const credited = rows.reduce((sum, row) => sum + row.creditKobo, 0);
    expect(debited).toBe(credited);
    expect(rows.find((row) => row.account === "buyer_refund")?.creditKobo).toBe(275_500);
  });

  it("maps product.retired reasons to the schema vocabulary and defaults unknown market", () => {
    const row = productRetiredRow({
      type: "product.retired",
      productId: "product-1",
      intentId: "intent-1",
      reason: "cart-retired",
      retiredAt: now,
      snapshot: productSnapshot,
    });
    expect(row.storeId).toBe("Amina's Fresh Store");
    expect(row.marketId).toBe("unknown");
    expect(row.buyerId).toBeNull();
    expect(row.retirementReason).toBe("cart_expired");
    expect(row.finalState).toEqual(productSnapshot);

    const sold = productRetiredRow({
      type: "product.retired",
      productId: "product-1",
      intentId: "intent-1",
      reason: "sold",
      retiredAt: now,
      snapshot: productSnapshot,
      market: "Balogun",
      buyerId: "buyer-1",
    });
    expect(sold.retirementReason).toBe("accepted");
    expect(sold.marketId).toBe("Balogun");
    expect(sold.buyerId).toBe("buyer-1");
  });

  it("keys cart snapshots by cart and retirement time", () => {
    expect(
      cartSnapshotKey({
        type: "cart.retired",
        cartId: "cart:a",
        market: "Balogun",
        reason: "checked-out",
        retiredAt: now,
        snapshot: {} as never,
      }),
    ).toBe(`snapshots/carts/cart:a/${now}.json`);
  });

  it("enumerates cart history without retaining deleted product media references", () => {
    const message = {
      type: "cart.retired" as const,
      cartId: "cart:a",
      market: "Balogun",
      reason: "checked-out" as const,
      retiredAt: now,
      snapshot: {
        id: "cart:a", market: "Balogun", firstAcceptedAt: now - 60_000,
        acceptanceCount: 1, deadline: now + 60_000, status: "checked-out" as const, buyerId: "buyer-1",
        products: [{
          ...productSnapshot, status: "accepted" as const,
          photoCaptureRef: "r2://archive/captures/photo.jpg", videoCaptureRef: "r2://archive/captures/video.mp4",
        }],
      },
    };
    const row = cartRetiredRow(message);
    expect(row.id).toBe(`cart:a:${now}`);
    expect(row.buyerId).toBe("buyer-1");
    expect(row.snapshot.products[0]).not.toHaveProperty("photoCaptureRef");
    expect(row.snapshot.products[0]).not.toHaveProperty("videoCaptureRef");
    expect(cartArchiveSnapshot(message)).toEqual(row.snapshot);
  });
});

/* ------------------------------------------------------------------------ */
/* Dispute persistence (ADR-0019): the dispute block rides run.retired.      */
/* ------------------------------------------------------------------------ */

const disputedRun: RunRetired = {
  ...runRetired,
  status: "closed",
  mode: "disputed",
  dispute: {
    reason: "buyer says the tomatoes never arrived",
    raisedByParticipantId: "buyer-1",
    evidenceRefs: ["r2://handoffs/h-1/photo.jpg"],
  },
  handoffs: [
    {
      id: "h-1",
      type: "pickup",
      exchangePoint: "Balogun Market, Stall B14",
      counterparty: "seller",
      status: "confirmed",
      requestedAt: now - 120_000,
      photoCaptureRef: "r2://handoffs/h-1/photo.jpg",
      scannedAt: now - 60_000,
      confirmedAt: now - 30_000,
    },
  ],
};

/**
 * Minimal ArchiveTx fake: records insert chains in order and emulates
 * onConflictDoNothing by keying rows on their `id`, so redelivery replays are
 * observable as no-ops. update(...).set(...).where(...) chains are recorded
 * and applied to nothing.
 */
function fakeArchiveTx() {
  const rowsByTable = new Map<unknown, Map<string, Record<string, unknown>>>();
  const inserts: Array<{ table: unknown; row: Record<string, unknown>; onConflict: "nothing" | "none" }> = [];
  const updates: Array<{ table: unknown; set: Record<string, unknown> }> = [];

  const tx = {
    insert(table: unknown) {
      const builder: Record<string, unknown> = {};
      let row: Record<string, unknown> | null = null;
      const apply = (onConflict: "nothing" | "none") => {
        inserts.push({ table, row: row!, onConflict });
        let store = rowsByTable.get(table);
        if (!store) rowsByTable.set(table, (store = new Map()));
        const id = String(row!.id);
        if (onConflict === "nothing" && store.has(id)) return;
        store.set(id, row!);
      };
      const thenable = (onConflict: "nothing" | "none") => ({
        then: (resolve: (value: void) => void) => {
          apply(onConflict);
          resolve();
        },
      });
      builder.values = (value: Record<string, unknown>) => {
        row = value;
        return Object.assign(builder, thenable("none"));
      };
      builder.onConflictDoNothing = () => Object.assign(builder, thenable("nothing"));
      return builder;
    },
    update(table: unknown) {
      const builder: Record<string, unknown> = {};
      builder.set = (value: Record<string, unknown>) => {
        updates.push({ table, set: value });
        return builder;
      };
      builder.where = () => ({ then: (resolve: (value: void) => void) => resolve() });
      return builder;
    },
  };
  return { tx: tx as unknown as ArchiveTx, rowsByTable, inserts, updates };
}

describe("dispute persistence from run.retired", () => {
  it("maps the dispute block onto a disputes row with a deterministic id", () => {
    const row = disputeRow(disputedRun);
    expect(row).not.toBeNull();
    expect(row!.id).toBe("run:cart:a:dispute");
    expect(row!.runId).toBe("run:cart:a");
    expect(row!.raisedByParticipantId).toBe("buyer-1");
    expect(row!.reason).toBe("buyer says the tomatoes never arrived");
    expect(row!.evidenceRefs).toEqual(["r2://handoffs/h-1/photo.jpg"]);
    expect(row!.status).toBe("open");
    expect(row!.createdAt).toEqual(new Date(now));
  });

  it("records a NULL raiser (timer close) as 'unknown' — the column is NOT NULL", () => {
    const row = disputeRow({
      ...disputedRun,
      dispute: { reason: "ambiguous close", raisedByParticipantId: null, evidenceRefs: [] },
    });
    expect(row!.raisedByParticipantId).toBe("unknown");
    expect(row!.evidenceRefs).toEqual([]);
  });

  it("maps nothing when the run closed undisputed", () => {
    expect(disputeRow(runRetired)).toBeNull();
  });

  it("persists the disputes row after the runs_archive row (FK ordering)", async () => {
    const { tx, rowsByTable, inserts } = fakeArchiveTx();
    await persistMessage(tx, disputedRun);

    const tables = inserts.map((entry) => entry.table);
    expect(tables.indexOf(runsArchive)).toBeGreaterThanOrEqual(0);
    expect(tables.indexOf(disputes)).toBeGreaterThan(tables.indexOf(runsArchive));

    const row = rowsByTable.get(disputes)?.get("run:cart:a:dispute");
    expect(row).toMatchObject({
      runId: "run:cart:a",
      raisedByParticipantId: "buyer-1",
      reason: "buyer says the tomatoes never arrived",
      status: "open",
    });
  });

  it("queue redelivery is a no-op replay — deterministic id + onConflictDoNothing", async () => {
    const { tx, rowsByTable, inserts } = fakeArchiveTx();
    await persistMessage(tx, disputedRun);
    await persistMessage(tx, disputedRun);

    const disputeInserts = inserts.filter((entry) => entry.table === disputes);
    expect(disputeInserts).toHaveLength(2);
    expect(disputeInserts.every((entry) => entry.onConflict === "nothing")).toBe(true);
    expect(rowsByTable.get(disputes)?.size).toBe(1);
  });

  it("writes no disputes row when the dispute block is absent", async () => {
    const { tx, rowsByTable, inserts } = fakeArchiveTx();
    await persistMessage(tx, runRetired);
    expect(inserts.some((entry) => entry.table === disputes)).toBe(false);
    expect(rowsByTable.has(disputes)).toBe(false);
  });
});
