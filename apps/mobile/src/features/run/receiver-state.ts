import type { DeliveryReceiver, Run, RunHandoff } from "@market-runs/proto";

export function receiverSelection(kind: "buyer" | "designated", name: string): DeliveryReceiver {
  if (kind === "buyer") return { kind: "buyer" };
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Enter the designated receiver's name.");
  return { kind: "designated", name: trimmed };
}

export function deliveryReceiverLabel(run: Run): string {
  return run.receiver?.kind === "designated" ? run.receiver.name : "Me (buyer)";
}

export function buyerCanConfirm(handoff: RunHandoff, run: Run): boolean {
  return handoff.type === "delivery" && handoff.status === "pending" && run.receiver?.kind !== "designated" &&
    handoff.scannedAt != null && handoff.photoCapturedAt != null && handoff.photoCapturedAt >= handoff.scannedAt;
}
