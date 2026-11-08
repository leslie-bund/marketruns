import type { PaymentDispatcher, TransferStatusLookup } from "./dispatcher.js";
import { paymentNotification, type PaymentNotificationSink } from "./notifications.js";
import type { DispatchRow, DispatchStore } from "./store.js";

export type DispatchSyncResult = "updated" | "unchanged" | "unmatched";

/**
 * Poll one dispatch without executing it. Missing provider references and
 * provider lookup misses are both non-mutating `unmatched` outcomes, matching
 * the bulk sync semantics. Only terminal provider outcomes mutate the row.
 */
export async function syncDispatchStatus(
  store: DispatchStore,
  dispatcher: PaymentDispatcher & TransferStatusLookup,
  row: DispatchRow,
  notify?: PaymentNotificationSink,
): Promise<DispatchSyncResult> {
  if (!row.providerRef) return "unmatched";
  const outcome = await dispatcher.fetchTransferStatus(row.providerRef);
  if (!outcome) return "unmatched";
  if (outcome.status !== "completed" && outcome.status !== "failed") return "unchanged";

  await store.recordStatus(row.id, {
    status: outcome.status,
    failureReason: outcome.status === "failed" ? outcome.failureReason ?? "provider reported failure" : null,
  });
  if (notify && row.account !== "platform") {
    await notify(paymentNotification({
      sourceEventId: `payment.dispatch-status:${row.id}:${outcome.status}`,
      sourceEventType: "payment.dispatch-updated",
      recipientId: row.partyId,
      title: outcome.status === "failed" ? "Dispatch failed" : "Dispatch completed",
      body: `Your ${row.account} dispatch is ${outcome.status}.`,
      runId: row.runId,
      deepLink: "/notifications",
      status: outcome.status,
    }));
  }
  return "updated";
}
