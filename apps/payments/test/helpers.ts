import type { PaymentDispatchRequested, PaymentRefundRequested } from "../src/messages.js";
import type { DispatchTransferResult } from "../src/dispatcher.js";
import type { PaymentDispatchStatus, PaymentHoldStatus, PaymentRefundStatus } from "@market-runs/proto";
import {
  dispatchRow,
  type DispatchListFilter,
  type DispatchListParams,
  type DispatchRow,
  type DispatchStatusUpdate,
  type DispatchStore,
} from "../src/store.js";
import type {
  BindRunResult,
  HoldListFilter,
  HoldListParams,
  HoldRow,
  HoldStore,
} from "../src/holds.js";
import type {
  RefundExecutionResult,
  RefundListFilter,
  RefundListParams,
  RefundRow,
  RefundStore,
} from "../src/refunds.js";
import type { PayoutAccountRow, PayoutAccountStore } from "../src/payout-accounts.js";
import type { QueueMessageLike } from "../src/consume.js";

/**
 * In-memory DispatchStore double: the same idempotency contract as
 * DrizzleDispatchStore (unique idempotency key, insert-if-absent), so the
 * consumer and HTTP surface run in the default suite without Postgres.
 */
export class InMemoryDispatchStore implements DispatchStore {
  readonly rows = new Map<string, DispatchRow>();

  async insertPending(row: DispatchRow): Promise<boolean> {
    for (const existing of this.rows.values()) {
      if (existing.idempotencyKey === row.idempotencyKey) return false;
    }
    this.rows.set(row.id, { ...row });
    return true;
  }

  async byIdempotencyKey(idempotencyKey: string): Promise<DispatchRow | null> {
    for (const row of this.rows.values()) {
      if (row.idempotencyKey === idempotencyKey) return { ...row };
    }
    return null;
  }

  async byId(id: string): Promise<DispatchRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async byProviderRef(providerRef: string): Promise<DispatchRow | null> {
    for (const row of this.rows.values()) {
      if (row.providerRef === providerRef) return { ...row };
    }
    return null;
  }

  async recordResult(id: string, result: DispatchTransferResult): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`dispatch ${id} is unknown`);
    row.status = result.status;
    row.providerRef = result.providerRef ?? null;
    row.failureReason = result.failureReason ?? null;
    row.failureRetryable = result.status === "failed" ? result.retryable !== false : true;
    row.attempts += 1;
    row.updatedAt = new Date();
  }

  async recordStatus(id: string, update: DispatchStatusUpdate): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`dispatch ${id} is unknown`);
    row.status = update.status;
    if (update.failureReason !== undefined) row.failureReason = update.failureReason;
    row.failureRetryable = update.retryable ?? (update.status !== "failed");
    row.updatedAt = new Date();
  }

  async listStale(statuses: PaymentDispatchStatus[], updatedBefore: Date, limit: number): Promise<DispatchRow[]> {
    return [...this.rows.values()]
      .filter((row) => statuses.includes(row.status) && row.updatedAt < updatedBefore)
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async list(filter: DispatchListFilter, params: DispatchListParams): Promise<{ items: DispatchRow[]; total: number }> {
    const matched = [...this.rows.values()].filter(
      (row) =>
        (filter.runId == null || row.runId === filter.runId) &&
        (filter.status == null || row.status === filter.status),
    );
    return {
      items: matched.slice(params.offset, params.offset + params.limit).map((row) => ({ ...row })),
      total: matched.length,
    };
  }
}

/** Queue message double recording ack/retry; `body` mirrors the real queue envelope (a JSON string on the wire). */
export class FakeMessage implements QueueMessageLike {
  acked = false;
  retries: Array<{ delaySeconds?: number }> = [];
  constructor(
    public readonly id: string,
    public readonly body?: unknown,
  ) {}
  ack(): void {
    this.acked = true;
  }
  retry(options?: { delaySeconds?: number }): void {
    this.retries.push(options ?? {});
  }
}

/** A two-leg dispatch request (one seller + runner) for consumer tests. */
export function sampleDispatchRequest(overrides: Partial<PaymentDispatchRequested> = {}): PaymentDispatchRequested {
  return {
    type: "payment.dispatch-requested",
    settlementRecordId: "run:cart:Balogun:buyer:1:settlement",
    runId: "run:cart:Balogun:buyer:1",
    market: "Balogun",
    legs: [
      { account: "seller", partyId: "seller:amina", amountKobo: 165_000, memo: "Seller settlement" },
      { account: "runner", partyId: "runner:internal", amountKobo: 170_000, memo: "Runner settlement" },
      { account: "platform", partyId: "platform", amountKobo: 26_500, memo: "Platform settlement" },
    ],
    idempotencyKey: "settlement:run:cart:Balogun:buyer:1:settlement",
    ...overrides,
  };
}

/* ------------------------------------------------------------------------ */
/* Collection-side doubles (holds, refunds, payout accounts) — same           */
/* idempotency contracts as the Drizzle stores, in-memory for tests.          */
/* ------------------------------------------------------------------------ */

export class InMemoryHoldStore implements HoldStore {
  readonly rows = new Map<string, HoldRow>();

  async insertIfAbsent(row: HoldRow): Promise<boolean> {
    for (const existing of this.rows.values()) {
      if (existing.txRef === row.txRef) return false;
    }
    this.rows.set(row.id, { ...row });
    return true;
  }

  async byTxRef(txRef: string): Promise<HoldRow | null> {
    for (const row of this.rows.values()) {
      if (row.txRef === txRef) return { ...row };
    }
    return null;
  }

  async byId(id: string): Promise<HoldRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async byRunId(runId: string): Promise<HoldRow | null> {
    for (const row of this.rows.values()) {
      if (row.runId === runId) return { ...row };
    }
    return null;
  }

  async bindRun(id: string, runId: string): Promise<BindRunResult> {
    const row = this.rows.get(id);
    if (!row) return "missing";
    if (row.runId === runId) return "already-bound";
    if (row.runId !== null) return "conflict";
    row.runId = runId;
    row.updatedAt = new Date();
    return "bound";
  }

  async setStatus(id: string, status: PaymentHoldStatus): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`hold ${id} is unknown`);
    row.status = status;
    row.updatedAt = new Date();
  }

  async release(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row && row.status === "held") {
      row.status = "released";
      row.updatedAt = new Date();
    }
  }

  async list(filter: HoldListFilter, params: HoldListParams): Promise<{ items: HoldRow[]; total: number }> {
    const matched = [...this.rows.values()].filter(
      (row) =>
        (filter.buyerId == null || row.buyerId === filter.buyerId) &&
        (filter.runId == null || row.runId === filter.runId) &&
        (filter.status == null || row.status === filter.status),
    );
    return {
      items: matched.slice(params.offset, params.offset + params.limit).map((row) => ({ ...row })),
      total: matched.length,
    };
  }
}

export class InMemoryRefundStore implements RefundStore {
  readonly rows = new Map<string, RefundRow>();

  async insertPending(row: RefundRow): Promise<boolean> {
    for (const existing of this.rows.values()) {
      if (existing.settlementRecordId === row.settlementRecordId) return false;
    }
    this.rows.set(row.id, { ...row });
    return true;
  }

  async bySettlementRecordId(settlementRecordId: string): Promise<RefundRow | null> {
    for (const row of this.rows.values()) {
      if (row.settlementRecordId === settlementRecordId) return { ...row };
    }
    return null;
  }

  async byId(id: string): Promise<RefundRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async recordResult(id: string, result: RefundExecutionResult): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`refund ${id} is unknown`);
    row.status = result.status;
    if (result.providerRef !== undefined) row.providerRef = result.providerRef;
    if (result.failureReason !== undefined) row.failureReason = result.failureReason;
    row.attempts += 1;
    row.updatedAt = new Date();
  }

  async committedForHold(holdId: string): Promise<number> {
    return [...this.rows.values()]
      .filter((row) => row.holdId === holdId && (row.status === "processing" || row.status === "completed"))
      .reduce((sum, row) => sum + row.amountKobo, 0);
  }

  async list(filter: RefundListFilter, params: RefundListParams): Promise<{ items: RefundRow[]; total: number }> {
    const matched = [...this.rows.values()].filter(
      (row) =>
        (filter.holdId == null || row.holdId === filter.holdId) &&
        (filter.settlementRecordId == null || row.settlementRecordId === filter.settlementRecordId) &&
        (filter.status == null || row.status === filter.status),
    );
    return {
      items: matched.slice(params.offset, params.offset + params.limit).map((row) => ({ ...row })),
      total: matched.length,
    };
  }
}

export class InMemoryPayoutAccountStore implements PayoutAccountStore {
  readonly rows = new Map<string, PayoutAccountRow>();

  async upsert(row: PayoutAccountRow): Promise<void> {
    const existing = this.rows.get(row.participantId);
    this.rows.set(row.participantId, { ...row, ...(existing ? { createdAt: existing.createdAt } : {}) });
  }

  async byParticipantId(participantId: string): Promise<PayoutAccountRow | null> {
    const row = this.rows.get(participantId);
    if (!row || row.revokedAt !== null) return null;
    return { ...row };
  }

  async revoke(participantId: string): Promise<boolean> {
    const row = this.rows.get(participantId);
    if (!row || row.revokedAt !== null) return false;
    row.revokedAt = new Date();
    row.updatedAt = new Date();
    return true;
  }
}

/** A held hold row for refund/gating tests. */
export function sampleHold(overrides: Partial<HoldRow> = {}): HoldRow {
  return {
    id: "hold:mr-cart-1-abc",
    txRef: "mr-cart-1-abc",
    providerTxId: "9049104",
    cartId: "cart:Balogun:buyer:1",
    runId: "run:cart:Balogun:buyer:1",
    buyerId: "buyer:1",
    amountKobo: 335_000,
    paymentMethod: "card",
    status: "held",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** A refund-requested message matching sampleHold's run. */
export function sampleRefundRequest(overrides: Partial<PaymentRefundRequested> = {}): PaymentRefundRequested {
  return {
    type: "payment.refund-requested",
    settlementRecordId: "run:cart:Balogun:buyer:1:settlement",
    runId: "run:cart:Balogun:buyer:1",
    buyerId: "buyer:1",
    amountKobo: 100_000,
    idempotencyKey: "refund:run:cart:Balogun:buyer:1:settlement",
    ...overrides,
  };
}
