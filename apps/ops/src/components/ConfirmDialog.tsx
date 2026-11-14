import { useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  children?: ReactNode;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export default function ConfirmDialog({ title, description, confirmLabel, destructive = false, children, onClose, onConfirm }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The action could not be completed.");
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="action-dialog">
        <DialogHeader>
          <div className={`dialog-symbol${destructive ? " danger" : ""}`}><AlertTriangle size={20} /></div>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)}>
          {children}
          {error && <p className="form-error" role="alert">{error}</p>}
          <DialogFooter>
            <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <button className={destructive ? "danger-button" : "primary-button"} type="submit" disabled={busy}>{busy ? "Applying…" : confirmLabel}</button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
