import { useState } from "react";
import { ArrowRight, RefreshCcw, Scale } from "lucide-react";
import ConfirmDialog from "../components/ConfirmDialog";
import { ActionNotice, CopyValue, DetailGrid, DetailRow, EmptyState, ErrorState, LoadingState, PageHeader, Pager, RefreshButton, SearchField, SelectField, StatusBadge } from "../components/ops";
import { useOpsUser } from "../lib/ops-context";
import { addQuery, dateTime, includesQuery, money, relativeTime } from "../lib/format";
import { redriveSettlement } from "../lib/ops-api";
import { usePagedResource, useResource } from "../hooks/use-resource";
import type { OpsMarket, Settlement } from "../lib/types";

export default function SettlementsPage() {
  const user = useOpsUser();
  const [market, setMarket] = useState("");
  const [query, setQuery] = useState("");
  const [selectedIdState, setSelectedId] = useState("");
  const [redrive, setRedrive] = useState(false);
  const [notice, setNotice] = useState("");
  const markets = useResource<{ markets: OpsMarket[] }>("/ops/api/markets");
  const resource = usePagedResource<Settlement>(addQuery("/ops/api/admin/settlements", { market: market || undefined }), 40);
  const items = (resource.data?.items ?? []).filter((item) => includesQuery([item.id, item.runId, item.market, item.mode], query));
  const selectedId = items.some((item) => item.id === selectedIdState) ? selectedIdState : items[0]?.id ?? "";
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const totals = items.reduce((sum, item) => ({ goods: sum.goods + item.goodsTotalKobo, runner: sum.runner + item.runnerKobo, platform: sum.platform + item.platformKobo, refunds: sum.refunds + item.buyerRefundKobo }), { goods: 0, runner: 0, platform: 0, refunds: 0 });

  return <div className="page-stack">
    <PageHeader eyebrow="Money decisions" title="Settlement records" description="Review the canonical outcome of completed, aborted, and disputed runs. Payment execution always carries these decisions verbatim." actions={<RefreshButton loading={resource.loading} onClick={resource.refresh} />} />
    <section className="metric-grid four compact-metrics"><div className="metric-card"><span>Goods on this page</span><strong>{money(totals.goods)}</strong></div><div className="metric-card"><span>Runner allocation</span><strong>{money(totals.runner)}</strong></div><div className="metric-card"><span>Platform allocation</span><strong>{money(totals.platform)}</strong></div><div className="metric-card"><span>Buyer refunds</span><strong>{money(totals.refunds)}</strong></div></section>
    <section className="filter-bar"><SearchField value={query} onChange={setQuery} placeholder="Settlement, run, market, or mode" /><SelectField label="Market" value={market} onChange={setMarket}><option value="">All markets</option>{markets.data?.markets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectField></section>
    <ActionNotice message={notice} />
    <div className="master-detail-layout">
      <section className="record-panel master-panel"><div className="panel-heading"><div><h2>Released decisions</h2><span>{resource.data?.total ?? 0} durable settlement records</span></div></div>
        {resource.loading && <LoadingState label="Loading settlement records…" />}{resource.error && <ErrorState error={resource.error} onRetry={resource.refresh} />}
        {!resource.loading && !resource.error && items.length === 0 && <EmptyState title="No settlements found" description="Settlement records appear when a run closes and its payment decision is released." icon={<Scale size={24} />} />}
        {items.length > 0 && <div className="table-scroll"><table className="data-table"><thead><tr><th>Settlement</th><th>Market</th><th>Mode</th><th>Goods</th><th>Runner</th><th>Released</th><th /></tr></thead><tbody>{items.map((item) => <tr key={item.id} className={selectedId === item.id ? "selected" : ""}><td><button className="record-link" type="button" onClick={() => setSelectedId(item.id)}>{item.id}</button><span className="cell-subtitle">Run · {item.runId}</span></td><td>{item.market}</td><td><StatusBadge status={item.mode} /></td><td className="money-cell">{money(item.goodsTotalKobo)}</td><td className="money-cell">{money(item.runnerKobo)}</td><td title={dateTime(item.releasedAt)}>{relativeTime(item.releasedAt)}</td><td><button className="icon-button" type="button" aria-label={`Inspect ${item.id}`} onClick={() => setSelectedId(item.id)}><ArrowRight size={16} /></button></td></tr>)}</tbody></table></div>}
        <Pager data={resource.data} page={resource.page} setPage={resource.setPage} pageSize={resource.pageSize} />
      </section>
      <aside className="record-panel detail-panel"><div className="panel-heading"><div><p className="overline">Canonical outcome</p><h2>Settlement inspector</h2></div>{selected && <StatusBadge status={selected.mode} />}</div>
        {!selected && <EmptyState title="Select a settlement" description="Choose a record to inspect its allocation and execution links." />}
        {selected && <div className="detail-stack"><div className="detail-title-row"><div><span className="subtle-label">Settlement record</span><CopyValue value={selected.id} display={selected.id} /></div></div><DetailGrid><DetailRow label="Run"><CopyValue value={selected.runId} display={selected.runId} /></DetailRow><DetailRow label="Market">{selected.market}</DetailRow><DetailRow label="Released">{dateTime(selected.releasedAt)}</DetailRow><DetailRow label="Mode"><StatusBadge status={selected.mode} /></DetailRow></DetailGrid>
          <section className="detail-section"><h3>Money allocation</h3><div className="money-breakdown"><div><span>Goods total</span><strong>{money(selected.goodsTotalKobo)}</strong></div><div><span>Runner</span><strong>{money(selected.runnerKobo)}</strong></div><div><span>Platform</span><strong>{money(selected.platformKobo)}</strong></div><div><span>Buyer refund</span><strong>{money(selected.buyerRefundKobo)}</strong></div><div className={selected.platformLossKobo > 0 ? "loss" : ""}><span>Platform loss</span><strong>{money(selected.platformLossKobo)}</strong></div></div></section>
          <div className="safeguard-note"><Scale size={17} /><p>These amounts are decided by the settlement function. Re-driving payments cannot edit legs or introduce another transfer.</p></div>
          {user.role === "admin" && <button className="secondary-button full-width" type="button" onClick={() => { setNotice(""); setRedrive(true); }}><RefreshCcw size={15} />Re-drive payment execution</button>}
        </div>}
      </aside>
    </div>
    {redrive && selected && <ConfirmDialog title="Re-drive payment execution?" description={`Re-drive the durable payment decision for settlement ${selected.id}. No amounts or legs will be changed.`} confirmLabel="Re-drive payments" onClose={() => setRedrive(false)} onConfirm={async () => { await redriveSettlement(selected.id); setRedrive(false); setNotice(`Payment execution was re-driven for ${selected.id}.`); resource.refresh(); }} />}
  </div>;
}
