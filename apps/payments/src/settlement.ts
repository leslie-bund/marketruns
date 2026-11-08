import { eq } from "drizzle-orm";
import {
  buildPaymentDispatchRequest,
  buildPaymentRefundRequest,
  type SettlementOutcome,
} from "@market-runs/domain";
import {
  runsArchive,
  settlementRecords,
  type SettlementOutcomeSnapshot,
} from "../../../infra/drizzle/schema.js";
import type { createDatabase } from "./db.js";
import type { PaymentDispatchRequested, PaymentQueueMessage, PaymentRefundRequested } from "./messages.js";

/** The durable settlement and archived-run facts that authorize payment execution. */
export type SettlementAuthorization = {
  settlementRecordId: string;
  runId: string;
  market: string;
  buyerId: string;
  runnerId: string;
  outcome: SettlementOutcome;
};

export interface SettlementListFilter {
  market?: string | null;
}

export interface SettlementStore {
  byId(settlementRecordId: string): Promise<SettlementAuthorization | null>;
  list(filter: SettlementListFilter): Promise<SettlementAuthorization[]>;
}

type Database = ReturnType<typeof createDatabase>["db"];

function requireKobo(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid durable settlement outcome: ${label} must be non-negative integer kobo`);
  }
  return value;
}

/** Copy the schema's JSON snapshot into the domain shape without trusting malformed JSON. */
function normalizeOutcome(snapshot: SettlementOutcomeSnapshot): SettlementOutcome {
  if (typeof snapshot !== "object" || snapshot === null || !Array.isArray(snapshot.sellers)) {
    throw new Error("Invalid durable settlement outcome: sellers must be an array");
  }
  return {
    sellers: snapshot.sellers.map((seller) => {
      if (typeof seller !== "object" || seller === null || typeof seller.sellerId !== "string" || seller.sellerId.length === 0) {
        throw new Error("Invalid durable settlement outcome: sellerId must be a non-empty string");
      }
      return { sellerId: seller.sellerId, amountKobo: requireKobo(seller.amountKobo, "seller amount") };
    }),
    runnerKobo: requireKobo(snapshot.runnerKobo, "runnerKobo"),
    platformKobo: requireKobo(snapshot.platformKobo, "platformKobo"),
    buyerRefundKobo: requireKobo(snapshot.buyerRefundKobo, "buyerRefundKobo"),
    platformLossKobo: requireKobo(snapshot.platformLossKobo, "platformLossKobo"),
  };
}

/** Read-only authorization lookup over the settlement record and its archived run. */
export class DrizzleSettlementStore implements SettlementStore {
  constructor(private readonly db: Database) {}

  async byId(settlementRecordId: string): Promise<SettlementAuthorization | null> {
    const rows = await this.db
      .select({
        settlementRecordId: settlementRecords.id,
        runId: settlementRecords.runId,
        market: runsArchive.marketId,
        buyerId: runsArchive.buyerId,
        runnerId: runsArchive.runnerId,
        outcome: settlementRecords.outcome,
      })
      .from(settlementRecords)
      .innerJoin(runsArchive, eq(settlementRecords.runId, runsArchive.id))
      .where(eq(settlementRecords.id, settlementRecordId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { ...row, outcome: normalizeOutcome(row.outcome) };
  }

  async list(filter: { market?: string | null }): Promise<SettlementAuthorization[]> {
    const rows = await this.db
      .select({
        settlementRecordId: settlementRecords.id,
        runId: settlementRecords.runId,
        market: runsArchive.marketId,
        buyerId: runsArchive.buyerId,
        runnerId: runsArchive.runnerId,
        outcome: settlementRecords.outcome,
      })
      .from(settlementRecords)
      .innerJoin(runsArchive, eq(settlementRecords.runId, runsArchive.id))
      .where(filter.market ? eq(runsArchive.marketId, filter.market) : undefined)
      .orderBy(settlementRecords.id);
    return rows.map((row) => ({ ...row, outcome: normalizeOutcome(row.outcome) }));
  }
}

/** Rebuild both execution requests from the durable money decision. */
export function expectedPaymentRequests(authorization: SettlementAuthorization) {
  return {
    dispatch: buildPaymentDispatchRequest(authorization.outcome, {
      runId: authorization.runId,
      market: authorization.market,
      runnerId: authorization.runnerId,
    }),
    refund: buildPaymentRefundRequest(authorization.outcome, {
      runId: authorization.runId,
      buyerId: authorization.buyerId,
    }),
  };
}

export type ExpectedPaymentRequests = ReturnType<typeof expectedPaymentRequests>;

export type PaymentRequestValidationResult =
  | { status: "valid" }
  | { status: "missing" }
  | { status: "mismatch" };

function dispatchMatches(expected: ExpectedPaymentRequests["dispatch"], message: PaymentDispatchRequested): boolean {
  if (expected.legs.length === 0) return false;
  return expected.settlementRecordId === message.settlementRecordId
    && expected.runId === message.runId
    && expected.market === message.market
    && expected.idempotencyKey === message.idempotencyKey
    && expected.legs.length === message.legs.length
    && expected.legs.every((leg, index) => {
      const actual = message.legs[index];
      return actual !== undefined
        && leg.account === actual.account
        && leg.partyId === actual.partyId
        && leg.amountKobo === actual.amountKobo
        && leg.memo === actual.memo;
    });
}

function refundMatches(expected: ExpectedPaymentRequests["refund"], message: PaymentRefundRequested): boolean {
  return expected !== null
    && expected.settlementRecordId === message.settlementRecordId
    && expected.runId === message.runId
    && expected.buyerId === message.buyerId
    && expected.amountKobo === message.amountKobo
    && expected.idempotencyKey === message.idempotencyKey;
}

/**
 * Authorize a parsed queue message against durable settlement state.
 * Correlation requestId is deliberately ignored; every money-bearing field is exact.
 */
export async function validatePaymentRequest(
  store: SettlementStore,
  message: PaymentQueueMessage,
): Promise<PaymentRequestValidationResult> {
  const authorization = await store.byId(message.settlementRecordId);
  if (!authorization) return { status: "missing" };
  const expected = expectedPaymentRequests(authorization);
  const valid = message.type === "payment.dispatch-requested"
    ? dispatchMatches(expected.dispatch, message)
    : refundMatches(expected.refund, message);
  return { status: valid ? "valid" : "mismatch" };
}
