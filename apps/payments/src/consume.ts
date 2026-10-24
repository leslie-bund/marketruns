import type { PaymentDispatcher } from "./dispatcher.js";
import type { PaymentDispatchRequested } from "./messages.js";
import type { HoldStore } from "./holds.js";
import { dispatchRowWithReference, type DispatchRow, type DispatchStore } from "./store.js";
import { paymentNotification, type PaymentNotificationSink } from "./notifications.js";

/**
 * The payment-dispatch consumer core. Execution only (ADR-0007/0008): the
 * settlement function computed these legs; we persist every dispatch attempt
 * and hand each leg to the PaymentDispatcher.
 *
 * Idempotency (at-least-once queue): the insert is keyed on the per-leg
 * idempotency key; a redelivered message finds its rows and
 *   - `sent` / `queued` / `completed` legs are skipped (no double payout, ever),
 *   - `pending` rows (crash between insert and dispatch) are dispatched,
 *   - retryable `failed` rows are re-dispatched — the queue-retry path,
 *   - terminal (`failureRetryable === false`) `failed` rows are skipped and
 *     acked; retrying the same deterministic rejection cannot help.
 * Retryable failures retry with backoff and eventually reach the DLQ. Terminal
 * failures are left for ops replay via POST /dispatches/:id/replay. In either
 * case the run's hold stays held — a failed leg means the money is not
 * reconciled, so release() must never run.
 */

/** The slice of the Workers queue Message API this consumer uses (mockable in tests). */
export interface QueueMessageLike {
  id: string;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

const BASE_RETRY_DELAY_SECONDS = 30;
const MAX_RETRY_DELAY_SECONDS = 600;

/** Exponential backoff over prior dispatch attempts, capped. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(BASE_RETRY_DELAY_SECONDS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_DELAY_SECONDS);
}

export async function handleDispatchRequested(
  store: DispatchStore,
  dispatcher: PaymentDispatcher,
  message: QueueMessageLike,
  value: PaymentDispatchRequested,
  holds?: HoldStore,
  notify?: PaymentNotificationSink,
): Promise<void> {
  let deepestAttempts = 0;
  let retryableFailure = false;
  /** Any leg left failed (terminal or retryable) keeps the hold blocked. */
  let blockingFailure = false;

  for (let index = 0; index < value.legs.length; index += 1) {
    let row: DispatchRow | null;
    // Persist the provider alias before the first send: a webhook can race
    // ahead of the HTTP response and must be able to find this row.
    const pending = await dispatchRowWithReference(value, index);
    const inserted = await store.insertPending(pending);
    if (inserted) {
      row = await store.byId(pending.id);
    } else {
      row = await store.byIdempotencyKey(pending.idempotencyKey);
    }
    if (!row) throw new Error(`dispatch row for leg ${index} of ${value.idempotencyKey} vanished after insert`);
    // Replay of an already-executed leg: the durable record says the money
    // moved (or was accepted by the provider) — never dispatch twice.
    // "completed" is terminal-settled; "sent"/"queued" are in-flight and
    // converge via webhook/sync, never via re-dispatch.
    if (row.status === "sent" || row.status === "queued" || row.status === "completed") continue;

    if (row.status === "failed") {
      // A deterministic rejection stays failed until an operator replays it.
      // Do not re-dispatch it on every queue redelivery: the provider would
      // reject it identically, and the hold must stay blocked.
      if (row.failureRetryable === false) {
        blockingFailure = true;
        continue;
      }
    }

    const leg = value.legs[index];
    if (!leg) throw new Error(`leg ${index} is out of range`);
    const result = await dispatcher.dispatchTransfer({
      idempotencyKey: row.idempotencyKey,
      ...(row.providerReference !== null ? { providerReference: row.providerReference } : {}),
      recipient: { partyId: row.partyId, account: row.account },
      amountKobo: row.amountKobo,
      memo: row.memo,
    });
    await store.recordResult(row.id, result);
    if (notify && row.account !== "platform") {
      await notify(paymentNotification({
        sourceEventId: `payment.dispatch:${row.id}:${result.status}:${row.attempts + 1}`,
        sourceEventType: "payment.dispatch-updated",
        recipientId: row.partyId,
        title: result.status === "failed" ? "Dispatch failed" : "Dispatch updated",
        body: `Your ${row.account} dispatch is ${result.status}.`,
        runId: row.runId,
        deepLink: "/notifications",
        status: result.status,
      }));
    }
    if (result.status === "failed") {
      blockingFailure = true;
      const retryable = result.retryable !== false;
      if (retryable) {
        retryableFailure = true;
        deepestAttempts = Math.max(deepestAttempts, row.attempts + 1);
      }
      console.error(
        JSON.stringify({
          event: "payment.dispatch_failed",
          dispatchId: row.id,
          failureReason: result.failureReason ?? "unknown",
          retryable,
          ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
        }),
      );
    }
  }

  if (retryableFailure) {
    message.retry({ delaySeconds: retryDelaySeconds(deepestAttempts) });
    return;
  }
  if (blockingFailure) {
    // Terminal failure(s) remain and nothing is left to retry: ack so the
    // queue does not spin, but never release the hold — the money is not
    // reconciled. The row stays failed and replayable from the ops console.
    message.ack();
    return;
  }

  // Every leg is executed or in-flight: the run's collected hold is released
  // (held → released). A partially-refunded/refunded hold keeps its refund
  // state — release() never overwrites it.
  if (holds) {
    const hold = await holds.byRunId(value.runId);
    if (hold) {
      await holds.release(hold.id);
      if (notify && hold.status === "held") {
        await notify(paymentNotification({
          sourceEventId: `payment.hold-released:${hold.id}`,
          sourceEventType: "payment.hold-released",
          recipientId: hold.buyerId,
          title: "Payment hold released",
          body: "Your held payment was released for settlement dispatch.",
          runId: value.runId,
          cartId: hold.cartId,
          status: "released",
        }));
      }
    }
  }
  message.ack();
}
