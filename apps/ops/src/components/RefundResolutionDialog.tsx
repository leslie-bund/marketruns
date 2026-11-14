import { useState } from "react";
import ConfirmDialog from "./ConfirmDialog";
import { resolveRefund, type ResolveRefundInput } from "../lib/ops-api";

export default function RefundResolutionDialog({ refundId, refundStatus, onClose, onResolved }: { refundId: string; refundStatus: string; onClose: () => void; onResolved: () => void }) {
  const [action, setAction] = useState<ResolveRefundInput["action"]>(refundStatus === "refund-manual" ? "complete-manual" : "allow-retry");
  const [status, setStatus] = useState<"processing" | "completed">("completed");
  const [providerRef, setProviderRef] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [note, setNote] = useState("");
  const [validation, setValidation] = useState("");

  const confirm = async () => {
    if (!evidenceRef.trim() || !note.trim()) {
      setValidation("Evidence reference and resolution note are required.");
      throw new Error("Complete the required evidence fields.");
    }
    if (action !== "allow-retry" && !providerRef.trim()) {
      setValidation("A provider or manual refund reference is required for this action.");
      throw new Error("Add the refund reference.");
    }
    await resolveRefund(refundId, {
      action,
      ...(action === "accept-provider" ? { status } : {}),
      ...(action !== "allow-retry" ? { providerRef: providerRef.trim() } : {}),
      evidenceRef: evidenceRef.trim(),
      note: note.trim(),
    });
    onResolved();
  };

  return <ConfirmDialog title="Resolve refund recovery" description={`Record one write-once evidence decision for ${refundId}. This does not edit the settlement amount.`} confirmLabel={action === "allow-retry" ? "Allow canonical retry" : "Record resolution"} onClose={onClose} onConfirm={confirm}>
    <div className="form-stack">
      <label>Resolution action<select value={action} onChange={(event) => { setAction(event.target.value as ResolveRefundInput["action"]); setValidation(""); }}><option value="allow-retry">Allow canonical retry after reconciliation</option><option value="accept-provider">Accept an existing provider refund</option><option value="complete-manual">Record a completed manual refund</option></select></label>
      {action === "accept-provider" && <label>Observed provider status<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="processing">Processing</option><option value="completed">Completed</option></select></label>}
      {action !== "allow-retry" && <label>{action === "complete-manual" ? "Manual refund reference" : "Provider refund reference"}<input value={providerRef} onChange={(event) => setProviderRef(event.target.value)} placeholder="Reference from the external refund record" /></label>}
      <label>Evidence reference<input required value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="Durable receipt, case, or evidence reference" /></label>
      <label>Resolution note<textarea required rows={4} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="What was reconciled, and why is this resolution safe?" /></label>
      {validation && <p className="form-error" role="alert">{validation}</p>}
      <p className="field-help">Resolution is write-once. Ambiguous provider history must be reconciled before any retry.</p>
    </div>
  </ConfirmDialog>;
}
