import { useState } from "react";
import { Check, KeyRound, ShieldX, X } from "lucide-react";
import ConfirmDialog from "../components/ConfirmDialog";
import { ActionNotice, CopyValue, DetailGrid, DetailRow, EmptyState, ErrorState, LoadingState, PageHeader, RefreshButton, SearchField, SelectField, StatusBadge } from "../components/ops";
import { addQuery, dateTime, includesQuery, relativeTime } from "../lib/format";
import { decideDeviceReset } from "../lib/ops-api";
import { useOpsUser } from "../lib/ops-context";
import { useResource } from "../hooks/use-resource";
import type { DeviceReset } from "../lib/types";

export default function AccessPage() {
  const user = useOpsUser();
  const [status, setStatus] = useState("pending");
  const [query, setQuery] = useState("");
  const [selectedIdState, setSelectedId] = useState("");
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(null);
  const [revokeSessions, setRevokeSessions] = useState(true);
  const [notice, setNotice] = useState("");
  const resource = useResource<{ requests: DeviceReset[] }>(addQuery("/ops/api/device-resets", { status: status || undefined }));
  const items = (resource.data?.requests ?? []).filter((item) => includesQuery([item.id, item.participantId, item.reason, item.resolvedBy], query));
  const selectedId = items.some((item) => item.id === selectedIdState) ? selectedIdState : items[0]?.id ?? "";
  const selected = items.find((item) => item.id === selectedId) ?? null;

  return <div className="page-stack">
    <PageHeader eyebrow="Identity recovery" title="Access recovery" description="Review participant device-reset requests and make final, audited decisions about credential and session revocation." actions={<RefreshButton loading={resource.loading} onClick={resource.refresh} />} />
    <div className="safeguard-note page-note"><KeyRound size={18} /><p>Approving a reset can revoke every device credential and live session. Rejecting leaves them unchanged. Decisions are final.</p></div>
    <ActionNotice message={notice} />
    <section className="filter-bar"><SearchField value={query} onChange={setQuery} placeholder="Request, participant, reason, or resolver" /><SelectField label="Status" value={status} onChange={setStatus}><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="">All requests</option></SelectField></section>
    <div className="master-detail-layout">
      <section className="record-panel master-panel"><div className="panel-heading"><div><h2>Device-reset requests</h2><span>{resource.data?.requests.length ?? 0} requests in this view</span></div></div>{resource.loading && <LoadingState label="Loading access-recovery requests…" />}{resource.error && <ErrorState title="Identity service unavailable" error={resource.error} onRetry={resource.refresh} />}{!resource.loading && !resource.error && items.length === 0 && <EmptyState title={status === "pending" ? "No pending resets" : "No requests found"} description="Participant device-recovery requests appear here for operator review." icon={<KeyRound size={24} />} />}{items.length > 0 && <div className="table-scroll"><table className="data-table"><thead><tr><th>Participant</th><th>Reason</th><th>Status</th><th>Requested</th><th>Resolved by</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className={selectedId === item.id ? "selected" : ""}><td><button className="record-link" type="button" onClick={() => setSelectedId(item.id)}>{item.participantId}</button><span className="cell-subtitle">{item.id}</span></td><td className="memo-cell">{item.reason}</td><td><StatusBadge status={item.status} /></td><td title={dateTime(item.createdAt)}>{relativeTime(item.createdAt)}</td><td>{item.resolvedBy ?? "—"}</td></tr>)}</tbody></table></div>}</section>
      <aside className="record-panel detail-panel"><div className="panel-heading"><div><p className="overline">Recovery decision</p><h2>Request inspector</h2></div>{selected && <StatusBadge status={selected.status} />}</div>{!selected && <EmptyState title="Select a request" description="Choose a device-reset request to review its reason and decision state." />}{selected && <div className="detail-stack"><div className="detail-title-row"><div><span className="subtle-label">Participant</span><CopyValue value={selected.participantId} display={selected.participantId} /></div></div><DetailGrid><DetailRow label="Request"><CopyValue value={selected.id} /></DetailRow><DetailRow label="Requested">{dateTime(selected.createdAt)}</DetailRow><DetailRow label="Resolved">{dateTime(selected.resolvedAt)}</DetailRow><DetailRow label="Resolved by">{selected.resolvedBy ?? "—"}</DetailRow></DetailGrid><section className="detail-section"><h3>Participant's recovery reason</h3><blockquote className="dispute-quote">{selected.reason}</blockquote></section>{selected.status === "pending" && user.role !== "viewer" && <div className="decision-buttons"><button className="primary-button" type="button" onClick={() => { setRevokeSessions(true); setDecision("approved"); }}><Check size={16} />Approve reset</button><button className="danger-button" type="button" onClick={() => setDecision("rejected")}><X size={16} />Reject request</button></div>}{selected.status !== "pending" && <div className={`resolution-banner${selected.status === "rejected" ? " rejected" : ""}`}>{selected.status === "approved" ? <Check size={18} /> : <ShieldX size={18} />}<div><strong>Decision is final</strong><p>This request was {selected.status} and cannot be decided again.</p></div></div>}</div>}</aside>
    </div>
    {decision && selected && <ConfirmDialog destructive={decision === "rejected"} title={`${decision === "approved" ? "Approve" : "Reject"} this device reset?`} description={decision === "approved" ? `Approve recovery for ${selected.participantId}. Credential and session revocation follows the selected policy.` : `Reject recovery for ${selected.participantId}. Existing credentials and sessions remain unchanged.`} confirmLabel={decision === "approved" ? "Approve reset" : "Reject request"} onClose={() => setDecision(null)} onConfirm={async () => { await decideDeviceReset(selected.id, decision, revokeSessions); setDecision(null); setNotice(`Request ${selected.id} was ${decision}.`); resource.refresh(); }}>{decision === "approved" && <label className="checkbox-field"><input type="checkbox" checked={revokeSessions} onChange={(event) => setRevokeSessions(event.target.checked)} /><span><strong>Revoke live sessions</strong><small>Device credentials are revoked by the approval flow. Keep this selected to also end active sessions.</small></span></label>}</ConfirmDialog>}
  </div>;
}
