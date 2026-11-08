import type { PaymentRecoveryIssue, PaymentRecoveryItem, PaymentRecoveryResponse } from "@market-runs/proto";
import { dispatchRowId, type DispatchStore } from "./store.js";
import type { HoldStore } from "./holds.js";
import { refundIdForSettlement, type RefundStore } from "./refunds.js";
import { expectedPaymentRequests, type SettlementStore } from "./settlement.js";

/** Read-only grouped attention queue; recovery never executes or mutates payment state. */
export async function listRecovery(
  settlements: SettlementStore,
  dispatches: DispatchStore,
  holds: HoldStore,
  refunds: RefundStore,
  market: string | null,
  now: Date,
): Promise<PaymentRecoveryResponse> {
  const authorizations = await settlements.list({ market });
  const staleBefore = now.getTime() - 15 * 60_000;
  const items: PaymentRecoveryItem[] = [];

  for (const authorization of authorizations) {
    const [rows, runHolds, runRefunds] = await Promise.all([
      dispatches.byRun(authorization.runId),
      holds.byRun(authorization.runId),
      refunds.forSettlement(authorization.settlementRecordId),
    ]);
    const issues: PaymentRecoveryIssue[] = [];
    const actions: PaymentRecoveryItem["actions"] = [];
    const actionKeys = new Set<string>();
    const addAction = (action: PaymentRecoveryItem["actions"][number]): void => {
      const key = `${action.type}:${action.targetId}`;
      if (actionKeys.has(key)) return;
      actionKeys.add(key);
      actions.push(action);
    };
    const redrive = (): void => addAction({ type: "redrive-settlement", targetId: authorization.settlementRecordId });

    const dispatchRows = rows
      .filter((row) =>
        row.status === "failed"
        || row.status === "pending"
        || ((row.status === "sent" || row.status === "queued") && row.updatedAt.getTime() < staleBefore))
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const row of dispatchRows) {
      issues.push({
        kind: "dispatch",
        id: row.id,
        status: row.status,
        amountKobo: row.amountKobo,
        updatedAt: row.updatedAt.getTime(),
      });
      addAction({
        type: row.status === "failed" || row.status === "pending" ? "replay-dispatch" : "sync-dispatch",
        targetId: row.id,
      });
    }

    const refundRows = runRefunds
      .filter((row) =>
        row.status === "failed"
        || row.status === "refund-review"
        || row.status === "refund-manual"
        || (row.status === "pending" && row.updatedAt.getTime() < staleBefore))
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const row of refundRows) {
      issues.push({
        kind: "refund",
        id: row.id,
        status: row.status,
        amountKobo: row.amountKobo,
        updatedAt: row.updatedAt.getTime(),
      });
      if (row.status === "refund-review" || row.status === "refund-manual") {
        addAction({ type: "resolve-refund", targetId: row.id });
      } else if (row.status === "failed") {
        redrive();
      }
    }

    const heldRows = runHolds
      .filter((row) => row.status === "held" && row.updatedAt.getTime() < staleBefore)
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const row of heldRows) {
      issues.push({
        kind: "hold",
        id: row.id,
        status: row.status,
        amountKobo: row.amountKobo,
        updatedAt: row.updatedAt.getTime(),
      });
      redrive();
    }

    const expected = expectedPaymentRequests(authorization);
    for (let index = 0; index < expected.dispatch.legs.length; index += 1) {
      const id = dispatchRowId(expected.dispatch, index);
      if (rows.some((row) => row.id === id)) continue;
      issues.push({
        kind: "missing",
        id,
        status: "missing",
        amountKobo: null,
        updatedAt: now.getTime(),
      });
      redrive();
    }

    if (expected.refund && runHolds.length > 0) {
      let remainingKobo = expected.refund.amountKobo;
      const planned = runHolds.map((hold) => {
        const amountKobo = Math.min(remainingKobo, hold.amountKobo);
        remainingKobo -= amountKobo;
        return { hold, amountKobo };
      });
      if (remainingKobo > 0 && planned[0]) planned[0].amountKobo += remainingKobo;
      for (const { hold, amountKobo } of planned) {
        if (amountKobo <= 0) continue;
        const id = refundIdForSettlement(
          expected.refund.settlementRecordId,
          runHolds.length > 1 ? hold.id : undefined,
        );
        if (runRefunds.some((row) => row.id === id)) continue;
        issues.push({
          kind: "missing",
          id,
          status: "missing",
          amountKobo: null,
          updatedAt: now.getTime(),
        });
        redrive();
      }
    }

    if (issues.length === 0) continue;
    items.push({
      settlementRecordId: authorization.settlementRecordId,
      runId: authorization.runId,
      market: authorization.market,
      buyerId: authorization.buyerId,
      runnerId: authorization.runnerId,
      issues,
      actions,
    });
  }

  return { items, total: items.length };
}
