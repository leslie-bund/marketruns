import { useState, type ReactNode } from "react";
import { AlertCircle, Check, ChevronLeft, ChevronRight, Copy, ExternalLink, FileSearch, Inbox, RefreshCw, Search } from "lucide-react";
import { captureUrl, shortId, titleCase } from "../lib/format";
import type { ListEnvelope } from "../lib/types";

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <p className="overline">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function StatusBadge({ status, label }: { status: string | boolean; label?: string }) {
  const value = String(status);
  const tone = ["completed", "closed", "confirmed", "delivered", "resolved", "approved", "active", "released", "true", "applied", "verified", "live", "persisted"].includes(value)
    ? "positive"
    : ["failed", "aborted", "rejected", "error", "expired", "false", "inactive", "refund-review"].includes(value)
      ? "negative"
      : ["open", "under_review", "disputed", "pending", "sent", "queued", "processing", "held", "refund-manual", "awaiting"].includes(value)
        ? "warning"
        : "neutral";
  return <span className={`status-pill ${tone}`}><span aria-hidden="true" />{label ?? (typeof status === "boolean" ? (status ? "Active" : "Inactive") : titleCase(value))}</span>;
}

export function RefreshButton({ loading, onClick, label = "Refresh" }: { loading: boolean; onClick: () => void; label?: string }) {
  return <button className="secondary-button compact-button" type="button" onClick={onClick} disabled={loading}><RefreshCw size={15} className={loading ? "spinning" : ""} />{loading ? "Refreshing…" : label}</button>;
}

export function LoadingState({ label = "Loading records…" }: { label?: string }) {
  return <div className="loading-state" role="status"><RefreshCw size={20} className="spinning" /><span>{label}</span></div>;
}

export function ErrorState({ title = "Could not load records", error, onRetry }: { title?: string; error: string; onRetry?: () => void }) {
  return <div className="error-state" role="alert"><AlertCircle size={21} /><div><strong>{title}</strong><p>{error}</p></div>{onRetry && <button className="secondary-button compact-button" type="button" onClick={onRetry}>Try again</button>}</div>;
}

export function EmptyState({ title, description, icon }: { title: string; description: string; icon?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon ?? <Inbox size={24} />}</div><strong>{title}</strong><p>{description}</p></div>;
}

export function SearchField({ value, onChange, placeholder = "Filter records", label = "Filter records" }: { value: string; onChange: (value: string) => void; placeholder?: string; label?: string }) {
  return <label className="search-field"><span className="sr-only">{label}</span><Search size={16} aria-hidden="true" /><input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

export function SelectField({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  return <label className="select-field"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{children}</select></label>;
}

export function DetailRow({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return <div className={`detail-row${wide ? " wide" : ""}`}><dt>{label}</dt><dd>{children}</dd></div>;
}

export function DetailGrid({ children }: { children: ReactNode }) {
  return <dl className="detail-grid">{children}</dl>;
}

export function CopyValue({ value, display }: { value: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  return <span className="copy-value"><code title={value}>{display ?? shortId(value, 34)}</code><button type="button" onClick={() => void copy()} aria-label={`Copy ${value}`}>{copied ? <Check size={13} /> : <Copy size={13} />}</button></span>;
}

export function Pager<T>({ data, page, setPage, pageSize }: { data: ListEnvelope<T> | null; page: number; setPage: (page: number) => void; pageSize: number }) {
  if (!data || data.total === 0) return null;
  const start = page * pageSize;
  const end = Math.min(start + data.items.length, data.total);
  return <div className="pager"><span>{start + 1}–{end} of {data.total}</span><div><button className="icon-button" type="button" aria-label="Previous page" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={17} /></button><span>Page {page + 1}</span><button className="icon-button" type="button" aria-label="Next page" disabled={end >= data.total} onClick={() => setPage(page + 1)}><ChevronRight size={17} /></button></div></div>;
}

export function TabList({ tabs, value, onChange, label }: { tabs: Array<{ id: string; label: string; count?: number }>; value: string; onChange: (value: string) => void; label: string }) {
  return <div className="tab-list" role="tablist" aria-label={label}>{tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={value === tab.id} className={value === tab.id ? "selected" : ""} onClick={() => onChange(tab.id)}>{tab.label}{tab.count !== undefined && <span>{tab.count}</span>}</button>)}</div>;
}

export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="json-block">{JSON.stringify(value ?? {}, null, 2)}</pre>;
}

export function EvidenceList({ refs }: { refs: string[] }) {
  if (refs.length === 0) return <p className="muted-copy">No evidence references were attached.</p>;
  return <ul className="evidence-list">{refs.map((ref) => {
    const url = captureUrl(ref);
    return <li key={ref}><FileSearch size={16} />{url ? <a href={url} target="_blank" rel="noreferrer"><span>{ref.split("/").pop()}</span><ExternalLink size={13} /></a> : <code>{ref}</code>}</li>;
  })}</ul>;
}

export function ActionNotice({ message, error }: { message: string; error?: boolean }) {
  if (!message) return null;
  return <p className={error ? "action-notice error" : "action-notice"} role={error ? "alert" : "status"}>{message}</p>;
}
