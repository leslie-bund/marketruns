import { useState } from "react";
import { ArrowUpRight, History, ShieldCheck } from "lucide-react";
import { Link } from "react-router";
import { CopyValue, DetailGrid, DetailRow, EmptyState, ErrorState, JsonBlock, LoadingState, PageHeader, RefreshButton, SearchField, SelectField, StatusBadge } from "../components/ops";
import { dateTime, includesQuery, relativeTime, titleCase } from "../lib/format";
import { useResource } from "../hooks/use-resource";
import type { AuditEvent } from "../lib/types";

export default function EventsPage() {
  const resource = useResource<{ items: AuditEvent[] }>("/ops/api/audit");
  const [query, setQuery] = useState("");
  const [entity, setEntity] = useState("");
  const [outcome, setOutcome] = useState("");
  const [selectedIdState, setSelectedId] = useState("");
  const all = resource.data?.items ?? [];
  const entities = [...new Set(all.map((item) => item.entityType))].sort();
  const items = all.filter((item) => (!entity || item.entityType === entity) && (!outcome || item.outcome === outcome) && includesQuery([item.action, item.entityId, item.summary, item.operatorEmail, item.requestId], query));
  const selectedId = items.some((item) => item.id === selectedIdState) ? selectedIdState : items[0]?.id ?? "";
  const selected = items.find((item) => item.id === selectedId) ?? null;

  return <div className="page-stack">
    <PageHeader eyebrow="Attributable activity" title="Events & audit" description="Review the append-only history of explicit operator actions, their outcomes, targets, request correlation, and supporting metadata." actions={<RefreshButton loading={resource.loading} onClick={resource.refresh} />} />
    <section className="audit-explainer"><ShieldCheck size={19} /><div><strong>No silent administration</strong><p>Settlement decisions, market changes, payment recovery, vocabulary moderation, and device-reset decisions create attributable records here.</p></div><Link to="/telemetry">Inspect live object events<ArrowUpRight size={15} /></Link></section>
    <section className="filter-bar"><SearchField value={query} onChange={setQuery} placeholder="Action, target, operator, or request ID" /><SelectField label="Entity" value={entity} onChange={setEntity}><option value="">All entities</option>{entities.map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}</SelectField><SelectField label="Outcome" value={outcome} onChange={setOutcome}><option value="">All outcomes</option><option value="applied">Applied</option><option value="rejected">Rejected</option></SelectField></section>
    <div className="master-detail-layout">
      <section className="record-panel master-panel"><div className="panel-heading"><div><h2>Operator event stream</h2><span>Latest {all.length} audit records · append only</span></div></div>
        {resource.loading && <LoadingState label="Loading operator events…" />}{resource.error && <ErrorState error={resource.error} onRetry={resource.refresh} />}
        {!resource.loading && !resource.error && items.length === 0 && <EmptyState title="No matching events" description="Explicit operator actions appear here after they are authorized and recorded." icon={<History size={24} />} />}
        {items.length > 0 && <div className="event-list">{items.map((item) => <button key={item.id} type="button" className={`event-row${selectedId === item.id ? " selected" : ""}`} onClick={() => setSelectedId(item.id)}><span className="event-marker" /><div><div className="event-title"><code>{item.action}</code><StatusBadge status={item.outcome} /></div><p>{item.summary}</p><footer><span>{item.operatorEmail}</span><span>{item.entityType} · {item.entityId}</span></footer></div><time title={dateTime(item.createdAt)}>{relativeTime(item.createdAt)}</time></button>)}</div>}
      </section>
      <aside className="record-panel detail-panel"><div className="panel-heading"><div><p className="overline">Audit envelope</p><h2>Event inspector</h2></div>{selected && <StatusBadge status={selected.outcome} />}</div>
        {!selected && <EmptyState title="Select an event" description="Choose an event to inspect its operator, correlation, and metadata." />}
        {selected && <div className="detail-stack"><div><code className="action-code">{selected.action}</code><p className="event-summary">{selected.summary}</p></div><DetailGrid><DetailRow label="Event"><CopyValue value={selected.id} /></DetailRow><DetailRow label="Recorded">{dateTime(selected.createdAt)}</DetailRow><DetailRow label="Operator">{selected.operatorEmail}</DetailRow><DetailRow label="Operator ID"><CopyValue value={selected.operatorId} /></DetailRow><DetailRow label="Entity">{titleCase(selected.entityType)}</DetailRow><DetailRow label="Target"><CopyValue value={selected.entityId} /></DetailRow><DetailRow label="Request ID">{selected.requestId ? <CopyValue value={selected.requestId} /> : "—"}</DetailRow><DetailRow label="Outcome"><StatusBadge status={selected.outcome} /></DetailRow></DetailGrid><section className="detail-section"><h3>Action metadata</h3><JsonBlock value={selected.metadata} /></section></div>}
      </aside>
    </div>
  </div>;
}
