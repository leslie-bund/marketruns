import { useState } from "react";
import { Archive, ArrowUpRight } from "lucide-react";
import { Link } from "react-router";
import ArchiveQueuePanel from "../components/ArchiveQueuePanel";
import { CopyValue, DetailGrid, DetailRow, EmptyState, ErrorState, LoadingState, PageHeader, Pager, RefreshButton, SearchField, SelectField, StatusBadge } from "../components/ops";
import { addQuery, dateTime, includesQuery, money } from "../lib/format";
import { usePagedResource, useResource } from "../hooks/use-resource";
import type { AdminRun, ArchivedRun, OpsMarket } from "../lib/types";

export default function ArchivePage() {
  const [market, setMarket] = useState("");
  const [query, setQuery] = useState("");
  const [selectedIdState, setSelectedId] = useState("");
  const markets = useResource<{ markets: OpsMarket[] }>("/ops/api/markets");
  const resource = usePagedResource<AdminRun>(addQuery("/ops/api/admin/runs", { kind: "archived", market: market || undefined }), 50);
  const items = ((resource.data?.items ?? []).filter((run): run is ArchivedRun => run.kind === "archived")).filter((run) => includesQuery([run.runId, run.cartId, run.market, run.buyerId, run.runnerId, run.status], query));
  const selectedId = items.some((run) => run.runId === selectedIdState) ? selectedIdState : items[0]?.runId ?? "";
  const selected = items.find((run) => run.runId === selectedId) ?? null;

  return <div className="page-stack">
    <PageHeader eyebrow="Durable history" title="Archived records" description="Inspect retired runs whose snapshots have left ephemeral Durable Object state and committed to Postgres and R2." actions={<RefreshButton loading={resource.loading} onClick={resource.refresh} />} />
    <section className="filter-bar"><SearchField value={query} onChange={setQuery} placeholder="Run, cart, buyer, runner, or market" /><SelectField label="Market" value={market} onChange={setMarket}><option value="">All markets</option>{markets.data?.markets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectField></section>
    <div className="master-detail-layout">
      <section className="record-panel master-panel"><div className="panel-heading"><div><h2>Retirement archive</h2><span>{resource.data?.total ?? 0} closed runs</span></div></div>
        {resource.loading && <LoadingState label="Reading archived run snapshots…" />}{resource.error && <ErrorState title="Archive unavailable" error={resource.error} onRetry={resource.refresh} />}
        {!resource.loading && !resource.error && items.length === 0 && <EmptyState title="No archived runs found" description="Runs join this durable history after retirement. Live runs remain in the Runs register." icon={<Archive size={24} />} />}
        {items.length > 0 && <div className="table-scroll"><table className="data-table"><thead><tr><th>Run</th><th>Market</th><th>Status</th><th>Floor rate</th><th>Final delivery</th><th>Closed</th></tr></thead><tbody>{items.map((run) => <tr key={run.runId} className={selectedId === run.runId ? "selected" : ""}><td><button className="record-link" type="button" onClick={() => setSelectedId(run.runId)}>{run.runId}</button><span className="cell-subtitle">Cart · {run.cartId}</span></td><td>{run.market}</td><td><StatusBadge status={run.status} /></td><td className="money-cell">{money(run.floorRateKobo)}</td><td>{dateTime(run.finalDeliveryAt)}</td><td>{dateTime(run.closedAt)}</td></tr>)}</tbody></table></div>}
        <Pager data={resource.data} page={resource.page} setPage={resource.setPage} pageSize={resource.pageSize} />
      </section>
      <aside className="record-panel detail-panel"><div className="panel-heading"><div><p className="overline">Retired snapshot</p><h2>Archive inspector</h2></div>{selected && <StatusBadge status="archived" />}</div>
        {!selected && <EmptyState title="Select an archived run" description="Choose a durable record to inspect its final state." />}
        {selected && <div className="detail-stack"><div className="detail-title-row"><div><span className="subtle-label">Run</span><CopyValue value={selected.runId} display={selected.runId} /></div><StatusBadge status={selected.status} /></div><DetailGrid><DetailRow label="Cart"><CopyValue value={selected.cartId} /></DetailRow><DetailRow label="Market">{selected.market}</DetailRow><DetailRow label="Buyer"><CopyValue value={selected.buyerId} /></DetailRow><DetailRow label="Runner"><CopyValue value={selected.runnerId} /></DetailRow><DetailRow label="Started">{dateTime(selected.startedAt)}</DetailRow><DetailRow label="Final delivery">{dateTime(selected.finalDeliveryAt)}</DetailRow><DetailRow label="Closed">{dateTime(selected.closedAt)}</DetailRow><DetailRow label="Floor rate">{money(selected.floorRateKobo)}</DetailRow></DetailGrid><div className="safeguard-note"><Archive size={17} /><p>Retirement deletes ephemeral object storage after snapshotting. Disputes, evidence references, settlements, and ledger entries remain in their durable read models.</p></div><div className="detail-link-list"><Link to="/runs">Open run register<ArrowUpRight size={14} /></Link><Link to="/disputes">Find related disputes<ArrowUpRight size={14} /></Link><Link to="/settlements">Find related settlements<ArrowUpRight size={14} /></Link></div></div>}
      </aside>
    </div>
    <ArchiveQueuePanel />
  </div>;
}
