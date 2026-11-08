/**
 * A retired-cart tombstone proves the original checkout landed. Recover only
 * that exact response; every other refusal keeps the caller's normal retry UI.
 */
export function checkoutRecoveryRunId(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { status?: unknown; code?: unknown; details?: unknown };
  if (candidate.status !== 409 || candidate.code !== "cart-already-checked-out") return null;
  if (typeof candidate.details !== "object" || candidate.details === null) return null;
  const runId = (candidate.details as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.trim().length > 0 ? runId : null;
}
