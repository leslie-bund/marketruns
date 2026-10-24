import type { NotificationTransition } from "@market-runs/proto";

export type NotificationDraft = NotificationTransition;

export function draftIdempotencyKey(draft: NotificationDraft): string {
  return draft.dedupeKey;
}
