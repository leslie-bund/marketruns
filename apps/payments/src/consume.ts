import type { PaymentDispatcher } from "./dispatcher.js";
import type { PaymentDispatchRequested } from "./messages.js";
import type { HoldStore } from "./holds.js";
import { dispatchRow, legIdempotencyKey, type DispatchRow, type DispatchStore } from "./store.js";

/**
 * The payment-dispatch consumer core. Execution only (ADR-0007/0008): the
 * settlement function computed these legs; we persist every dispatch attempt
 * and hand each leg to the PaymentDispatcher.
 *
 * Idempotency (at-least-once queue): the insert is keyed on the per-leg
 * idempotency key; a redelivered message finds its rows and
 *   - `sent` / `queued` / `completed` legs are skipped (no double payout, ever),
 *   - `pending` rows (crash between insert and dispatch) are dispatched,
 *   - `failed` rows are retried — this is the queue-retry path.
 * If any leg fails, the message is retried with backoff; after the queue's
 * max_retries it lands in the DLQ and the row stays `failed`, visible to ops
 * via GET /dispatches?status=failed and re-runnable via the replay endpoint.
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
): Promise<void> {
  let deepestAttempts = 0;
  let anyFailed = false;

  for (let index = 0; index < value.legs.length; index += 1) {
    let row: DispatchRow | null;
    const inserted = await store.insertPending(dispatchRow(value, index));
    if (inserted) {
      row = await store.byId(dispatchRow(value, index).id);
    } else {
      row = await store.byIdempotencyKey(legIdempotencyKey(value, index));
    }
    if (!row) throw new Error(`dispatch row for leg ${index} of ${value.idempotencyKey} vanished after insert`);
    // Replay of an already-executed leg: the durable record says the money
    // moved (or was accepted by the provider) — never dispatch twice.
    // "completed" is terminal-settled; "sent"/"queued" are in-flight and
    // converge via webhook/sync, never via re-dispatch.
    if (row.status === "sent" || row.status === "queued" || row.status === "completed") continue;

    const leg = value.legs[index];
    if (!leg) throw new Error(`leg ${index} is out of range`);
    const result = await dispatcher.dispatchTransfer({
      idempotencyKey: row.idempotencyKey,
      recipient: { partyId: row.partyId, account: row.account },
      amountKobo: row.amountKobo,
      memo: row.memo,
    });
    await store.recordResult(row.id, result);
    if (result.status === "failed") {
      anyFailed = true;
      deepestAttempts = Math.max(deepestAttempts, row.attempts + 1);
      console.error(
        JSON.stringify({
          event: "payment.dispatch_failed",
          dispatchId: row.id,
          failureReason: result.failureReason ?? "unknown",
          ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
        }),
      );
    }
  }

  if (anyFailed) {
    message.retry({ delaySeconds: retryDelaySeconds(deepestAttempts) });
  } else {
    // Every leg is executed or in-flight: the run's collected hold is
    // released (held → released). A partially-refunded/refunded hold keeps
    // its refund state — release() never overwrites it.
    if (holds) {
      const hold = await holds.byRunId(value.runId);
      if (hold) await holds.release(hold.id);
    }
    message.ack();
  }
}
