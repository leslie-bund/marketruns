import { useState } from "react";
import { ArrowRight, Route } from "lucide-react";
import { Link } from "react-router";
import RunDetail from "../components/RunDetail";
import { CopyValue, EmptyState, ErrorState, LoadingState, PageHeader, Pager, RefreshButton, SearchField, SelectField, StatusBadge } from "../components/ops";
import { addQuery, dateTime, includesQuery, money, relativeTime } from "../lib/format";
import { usePagedResource, useResource } from "../hooks/use-resource";
import type { AdminRun, OpsMarket, OpsRunDetail } from "../lib/types";

export default function RunsPage() {
  const [kind, setKind] = useState("live");
  const [market, setMarket] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [selectedState, setSelected] = useState("");
  const markets = useResource<{ markets: OpsMarket[] }>("/ops/api/markets");
  const resource = usePagedResource<AdminRun>(addQuery("/ops/api/admin/runs", { kind: kind || undefined, market: market || undefined, status: status || undefined }), 40);
  const items = (resource.data?.items ?? []).filter((run) => includesQuery([run.runId, run.market, run.buyerId, run.runnerId, run.status], query));
  const selected = items.some((run) => run.runId === selectedState) ? selectedState : items[0]?.runId ?? "";
  const detail = useResource<OpsRunDetail>(selected ? `/ops/api/runs/${encodeURIComponent(selected)}` : null);

  return <div className="page-stack">
    <PageHeader eyebrow="Fulfillment" title="Runs" description="Inspect live execution, participant assignments, collection progress, handoffs, and evidence without enumerating Durable Objects." actions={<RefreshButton loading={resource.loading} onClick={() => { resource.refresh(); detail.refresh(); }} />} />
    <section className="filter-bar" aria-label="Run filters">
      <SearchField value={query} onChange={setQuery} placeholder="Run, buyer, runner, or market" />
      <SelectField label="Record" value={kind} onChange={setKind}><option value="live">Live runs</option><option value="archived">Archived runs</option><option value="">All records</option></SelectField>
      <SelectField label="Market" value={market} onChange={setMarket}><option value="">All markets</option>{markets.data?.markets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectField>
      <SelectField label="Status" value={status} onChange={setStatus}><option value="">All statuses</option>{["unassigned", "assigned", "collecting", "delivering", "delivered", "closed", "aborted"].map((item) => <option key={item}>{item}</option>)}</SelectField>
    </section>

    <div className="master-detail-layout">
      <section className="record-panel master-panel" aria-label="Run records">
        <div className="panel-heading"><div><h2>{kind === "archived" ? "Run history" : kind === "live" ? "Live run register" : "All runs"}</h2><span>{resource.data?.total ?? 0} durable index records</span></div></div>
        {resource.loading && <LoadingState label="Loading the run register…" />}
        {resource.error && <ErrorState error={resource.error} onRetry={resource.refresh} />}
        {!resource.loading && !resource.error && items.length === 0 && <EmptyState title="No matching runs" description={query ? "Clear the filter or change the current page." : "Runs appear after checkout and remain discoverable after retirement."} icon={<Route size={24} />} />}
        {items.length > 0 && <div className="table-scroll"><table className="data-table"><thead><tr><th>Run</th><th>Market</th><th>Status</th><th>Participants</th><th>Started</th><th /></tr></thead><tbody>{items.map((run) => <tr key={`${run.kind}-${run.runId}`} className={selected === run.runId ? "selected" : ""}>
          <td><button className="record-link" type="button" onClick={() => setSelected(run.runId)}>{run.runId}</button><span className="cell-subtitle">{run.kind}{run.kind === "live" ? ` · ${run.stopCount} stops` : ` · ${money(run.floorRateKobo)}`}</span></td>
          <td>{run.market}</td><td><StatusBadge status={run.status} /></td>
          <td><span className="cell-stack"><span>Buyer · {run.buyerId}</span><span>Runner · {run.runnerId ?? "Unassigned"}</span></span></td>
          <td><span title={dateTime(run.kind === "live" ? run.startedAt : run.closedAt)}>{relativeTime(run.kind === "live" ? run.startedAt : run.closedAt)}</span></td>
          <td><button className="icon-button" type="button" aria-label={`Inspect ${run.runId}`} onClick={() => setSelected(run.runId)}><ArrowRight size={16} /></button></td>
        </tr>)}</tbody></table></div>}
        <Pager data={resource.data} page={resource.page} setPage={resource.setPage} pageSize={resource.pageSize} />
      </section>

      <aside className="record-panel detail-panel" aria-label="Selected run detail">
        <div className="panel-heading"><div><p className="overline">Execution detail</p><h2>Run inspector</h2></div>{selected && <CopyValue value={selected} />}</div>
        {!selected && <EmptyState title="Select a run" description="Choose a record to inspect its route and handoffs." />}
        {selected && detail.loading && <LoadingState label="Reading live RunDO state…" />}
        {selected && detail.error && <ErrorState title="Run detail unavailable" error={detail.error} onRetry={detail.refresh} />}
        {selected && !detail.loading && !detail.error && <RunDetail detail={detail.data} archivedMessage="This run has retired, so its live Durable Object is gone. The durable archive summary remains available." />}
        {detail.data?.dispute && <Link className="primary-button detail-action" to="/disputes">Review dispute<ArrowRight size={15} /></Link>}
      </aside>
    </div>
  </div>;
}
