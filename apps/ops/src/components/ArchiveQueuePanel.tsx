import { useState } from "react";
import { ListRestart } from "lucide-react";
import { CopyValue, EmptyState, ErrorState, LoadingState, Pager, RefreshButton, SelectField, StatusBadge } from "./ops";
import { useResource } from "../hooks/use-resource";
import { addQuery, dateTime, relativeTime } from "../lib/format";
import type { ArchiveQueueResponse, ArchiveQueueStatus } from "../lib/types";

export default function ArchiveQueuePanel() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);
  const pageSize = 50;
  const resource = useResource<ArchiveQueueResponse>(addQuery("/ops/api/admin/archive-queue", { status: status || undefined, limit: pageSize, offset: page * pageSize }));
  const summary = resource.data?.summary;

  return <section className="content-section">
    <div className="section-heading inline"><div><p className="overline">Delivery pipeline</p><h2>Archive queue activity</h2><p>Durable consumer receipts for archive messages, retries, and schema rejection.</p></div><RefreshButton loading={resource.loading} onClick={resource.refresh} /></div>
    <div className="metric-grid four">
      <div className="metric-card"><div><span>Persisted</span><StatusBadge status="persisted" /></div><strong>{summary?.persisted ?? "—"}</strong><p>Committed and acknowledged</p></div>
      <div className="metric-card attention"><div><span>Retrying</span><StatusBadge status="retrying" /></div><strong>{summary?.retrying ?? "—"}</strong><p>{summary?.oldestUnresolvedAt ? `Oldest since ${relativeTime(summary.oldestUnresolvedAt)}` : "No unresolved retries"}</p></div>
      <div className="metric-card"><div><span>Received</span><StatusBadge status="received" /></div><strong>{summary?.received ?? "—"}</strong><p>Received, not yet completed</p></div>
      <div className="metric-card"><div><span>Rejected</span><StatusBadge status="rejected" /></div><strong>{summary?.rejected ?? "—"}</strong><p>Invalid messages acknowledged</p></div>
    </div>
    <section className="filter-bar"><SelectField label="Receipt status" value={status} onChange={setStatus}><option value="">All receipts</option>{(["received", "persisted", "retrying", "rejected"] as ArchiveQueueStatus[]).map((value) => <option key={value} value={value}>{value}</option>)}</SelectField></section>
    <div className="safeguard-note"><ListRestart size={17} /><p>These are durable consumer receipts, not a live Cloudflare backlog gauge. Received and retrying receipts identify messages that have not completed cleanly.</p></div>
    {resource.loading && <LoadingState label="Loading archive queue receipts…" />}
    {resource.error && <ErrorState title="Queue activity unavailable" error={resource.error} onRetry={resource.refresh} />}
    {!resource.loading && !resource.error && resource.data?.items.length === 0 && <EmptyState title="No queue receipts found" description="Archive messages will appear here when the consumer receives them." />}
    {resource.data && resource.data.items.length > 0 && <div className="table-scroll"><table className="data-table"><thead><tr><th>Message</th><th>Status</th><th>Attempts</th><th>Last update</th><th>Completed</th><th>Error</th></tr></thead><tbody>{resource.data.items.map((message) => <tr key={message.id}><td><CopyValue value={message.id} /><span className="cell-subtitle">{message.eventType}{message.requestId ? ` · ${message.requestId}` : ""}</span></td><td><StatusBadge status={message.status} /></td><td>{message.attempts}</td><td title={dateTime(message.updatedAt)}>{relativeTime(message.updatedAt)}</td><td>{dateTime(message.completedAt)}</td><td className="memo-cell">{message.error ?? "—"}</td></tr>)}</tbody></table></div>}
    <Pager data={resource.data} page={page} setPage={setPage} pageSize={pageSize} />
  </section>;
}
