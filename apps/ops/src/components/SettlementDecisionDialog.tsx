import { useState, type FormEvent } from "react";
import { LockKeyhole, Scale } from "lucide-react";
import RunDetail from "./RunDetail";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { ErrorState, LoadingState } from "./ops";
import { money } from "../lib/format";
import { settleRun } from "../lib/ops-api";
import { useResource } from "../hooks/use-resource";
import type { OpsRunDetail } from "../lib/types";

export default function SettlementDecisionDialog({ runId, onClose, onSettled }: { runId: string; onClose: () => void; onSettled: () => void }) {
  const detail = useResource<OpsRunDetail>(`/ops/api/runs/${encodeURIComponent(runId)}`);
  const [mode, setMode] = useState<"completed" | "aborted" | "disputed">("disputed");
  const [reason, setReason] = useState("");
  const [ambiguous, setAmbiguous] = useState(true);
  const [requestedLoss, setRequestedLoss] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) {
      setError("Add the evidence-based reason for this decision.");
      return;
    }
    const lossNaira = requestedLoss.trim() ? Number(requestedLoss) : undefined;
    if (lossNaira !== undefined && (!Number.isFinite(lossNaira) || lossNaira < 0)) {
      setError("Requested platform loss must be a non-negative naira amount.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await settleRun(runId, {
        mode,
        reason: reason.trim(),
        ...(mode === "disputed" ? { ambiguous, ...(ambiguous && lossNaira !== undefined ? { requestedPlatformLossKobo: Math.round(lossNaira * 100) } : {}) } : {}),
      });
      onSettled();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Settlement could not be released.");
      setBusy(false);
    }
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="settlement-dialog">
      <DialogHeader><div className="dialog-symbol"><Scale size={20} /></div><DialogTitle>Review evidence. Release one canonical decision.</DialogTitle><DialogDescription>Run {runId}. Settlement computes every allocation; this action cannot transfer money directly.</DialogDescription></DialogHeader>
      <div className="settlement-review-grid">
        <div className="settlement-run-review">{detail.loading && <LoadingState label="Loading the live run and merged evidence…" />}{detail.error && <ErrorState title="Live review unavailable" error={detail.error} onRetry={detail.refresh} />}{!detail.loading && !detail.error && <RunDetail detail={detail.data} archivedMessage="The live RunDO has retired. An operator cannot settle through this control; use the durable recovery flow instead." />}</div>
        <form className="settlement-form" onSubmit={(event) => void submit(event)}>
          <div className="safeguard-note"><LockKeyhole size={17} /><p>Admin-only escape hatch. Review photo evidence and handoff timestamps before choosing a mode.</p></div>
          <label>Decision mode<select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="disputed">Disputed — resolve contested evidence</option><option value="aborted">Aborted — partial settlement, never a full refund</option><option value="completed">Completed — release the completed allocation</option></select></label>
          {mode === "disputed" && <>
            <label className="checkbox-field"><input type="checkbox" checked={ambiguous} onChange={(event) => setAmbiguous(event.target.checked)} /><span><strong>Evidence is ambiguous</strong><small>The platform absorbs a capped loss when responsibility cannot be established.</small></span></label>
            {ambiguous && <label>Requested platform loss (₦)<input type="number" min="0" step="0.01" inputMode="decimal" value={requestedLoss} onChange={(event) => setRequestedLoss(event.target.value)} placeholder="Optional cap request" /><small>The settlement function applies the actual policy cap{requestedLoss && Number.isFinite(Number(requestedLoss)) ? `; requested ${money(Math.round(Number(requestedLoss) * 100))}` : ""}.</small></label>}
          </>}
          <label>Decision reason<textarea required rows={5} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Summarize the evidence and why this mode is appropriate" /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <DialogFooter><button className="secondary-button" type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="primary-button" type="submit" disabled={busy || detail.loading || Boolean(detail.error) || !detail.data?.run}>{busy ? "Releasing…" : "Release settlement"}</button></DialogFooter>
        </form>
      </div>
    </DialogContent>
  </Dialog>;
}
