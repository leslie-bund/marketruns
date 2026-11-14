import { useState } from "react";
import { AlertTriangle, ArrowRight, FileCheck2, LockKeyhole, Scale } from "lucide-react";
import SettlementDecisionDialog from "../components/SettlementDecisionDialog";
import { ActionNotice, CopyValue, DetailGrid, DetailRow, EmptyState, ErrorState, EvidenceList, LoadingState, PageHeader, Pager, RefreshButton, SearchField, SelectField, StatusBadge } from "../components/ops";
import { addQuery, dateTime, includesQuery, money, relativeTime } from "../lib/format";
import { useOpsUser } from "../lib/ops-context";
import { usePagedResource } from "../hooks/use-resource";
import type { Dispute } from "../lib/types";

export default function DisputesPage() {
  const user = useOpsUser();
  const [status, setStatus] = useState("open");
  const [query, setQuery] = useState("");
  const [selectedIdState, setSelectedId] = useState("");
  const [settle, setSettle] = useState(false);
  const [notice, setNotice] = useState("");
  const resource = usePagedResource<Dispute>(addQuery("/ops/api/admin/disputes", { status: status || undefined }), 40);
  const items = (resource.data?.items ?? []).filter((item) => includesQuery([item.id, item.runId, item.market, item.raisedByParticipantId, item.reason, item.settlementRecordId], query));
  const selectedId = items.some((item) => item.id === selectedIdState) ? selectedIdState : items[0]?.id ?? "";
  const selected = items.find((item) => item.id === selectedId) ?? null;

  return <div className="page-stack">
    <PageHeader eyebrow="Intervention management" title="Disputes" description="Review participant claims, merged handoff evidence, ambiguity, absorbed loss, and final settlement resolution in one dedicated workflow." actions={<RefreshButton loading={resource.loading} onClick={resource.refresh} />} />
    <section className="dispute-principles"><div><FileCheck2 size={18} /><span><strong>Evidence first</strong>Photos and scan timestamps are merged server-side.</span></div><div><AlertTriangle size={18} /><span><strong>Ambiguity is explicit</strong>Platform loss is recorded and capped by settlement policy.</span></div><div><Scale size={18} /><span><strong>One money decision</strong>Resolution releases settlement; it never edits amounts directly.</span></div></section>
    <section className="filter-bar"><SearchField value={query} onChange={setQuery} placeholder="Dispute, run, raiser, market, or reason" /><SelectField label="Status" value={status} onChange={setStatus}><option value="open">Open</option><option value="under_review">Under review</option><option value="resolved">Resolved</option><option value="">All disputes</option></SelectField></section>
    <ActionNotice message={notice} />
    <div className="master-detail-layout">
      <section className="record-panel master-panel"><div className="panel-heading"><div><h2>{status ? `${status.replace("_", " ")} disputes` : "All disputes"}</h2><span>{resource.data?.total ?? 0} durable records</span></div></div>
        {resource.loading && <LoadingState label="Loading the intervention queue…" />}{resource.error && <ErrorState error={resource.error} onRetry={resource.refresh} />}
        {!resource.loading && !resource.error && items.length === 0 && <EmptyState title={status === "open" ? "No open disputes" : "No disputes found"} description={query ? "No records on this page match the current filter." : "The intervention queue is clear for this status."} icon={<Scale size={24} />} />}
        {items.length > 0 && <div className="dispute-list">{items.map((item) => <button type="button" key={item.id} className={`dispute-row${selectedId === item.id ? " selected" : ""}`} onClick={() => setSelectedId(item.id)}><div className="dispute-row-top"><StatusBadge status={item.status} /><span>{item.market}</span><time title={dateTime(item.createdAt)}>{relativeTime(item.createdAt)}</time><ArrowRight size={15} /></div><strong>{item.runId}</strong><p>{item.reason}</p><footer><span>{item.evidenceRefs.length} evidence items</span>{item.ambiguous && <StatusBadge status="ambiguous" />}<span>{money(item.absorbedLossKobo)} absorbed loss</span></footer></button>)}</div>}
        <Pager data={resource.data} page={resource.page} setPage={resource.setPage} pageSize={resource.pageSize} />
      </section>
      <aside className="record-panel detail-panel"><div className="panel-heading"><div><p className="overline">Evidence & resolution</p><h2>Dispute inspector</h2></div>{selected && <StatusBadge status={selected.status} />}</div>
        {!selected && <EmptyState title="Select a dispute" description="Choose a record to review its reason, evidence, and resolution." />}
        {selected && <div className="detail-stack"><div className="detail-title-row"><div><span className="subtle-label">Dispute</span><CopyValue value={selected.id} display={selected.id} /></div></div><DetailGrid><DetailRow label="Run"><CopyValue value={selected.runId} display={selected.runId} /></DetailRow><DetailRow label="Market">{selected.market}</DetailRow><DetailRow label="Raised by"><CopyValue value={selected.raisedByParticipantId} /></DetailRow><DetailRow label="Raised">{dateTime(selected.createdAt)}</DetailRow><DetailRow label="Ambiguous evidence">{selected.ambiguous ? <StatusBadge status="ambiguous" label="Ambiguous" /> : "No"}</DetailRow><DetailRow label="Absorbed loss">{money(selected.absorbedLossKobo)}</DetailRow>{selected.settlementRecordId && <DetailRow label="Settlement"><CopyValue value={selected.settlementRecordId} /></DetailRow>}{selected.resolvedAt && <DetailRow label="Resolved">{dateTime(selected.resolvedAt)}</DetailRow>}</DetailGrid>
          <section className="detail-section"><h3>Participant claim</h3><blockquote className="dispute-quote">{selected.reason}</blockquote></section>
          <section className="detail-section"><div className="detail-section-heading"><h3>Evidence bundle</h3><span>{selected.evidenceRefs.length} items</span></div><EvidenceList refs={selected.evidenceRefs} /></section>
          {selected.status !== "resolved" && (user.role === "admin" ? <button className="primary-button full-width" type="button" onClick={() => { setNotice(""); setSettle(true); }}><Scale size={16} />Review live run & settle</button> : <div className="safeguard-note"><LockKeyhole size={17} /><p>An administrator must review the live run and release the settlement decision.</p></div>)}
          {selected.status === "resolved" && <div className="resolution-banner"><FileCheck2 size={18} /><div><strong>Resolution recorded</strong><p>{selected.settlementRecordId ? `Settlement ${selected.settlementRecordId}` : "The durable dispute has been resolved."}</p></div></div>}
        </div>}
      </aside>
    </div>
    {settle && selected && <SettlementDecisionDialog runId={selected.runId} onClose={() => setSettle(false)} onSettled={() => { setSettle(false); setNotice(`Settlement released for ${selected.runId}; refreshing the dispute record.`); resource.refresh(); }} />}
  </div>;
}
