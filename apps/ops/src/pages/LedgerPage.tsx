import { useState } from "react";
import { BookOpenText } from "lucide-react";
import { CopyValue, DetailGrid, DetailRow, EmptyState, ErrorState, LoadingState, PageHeader, Pager, RefreshButton, SearchField, SelectField, StatusBadge } from "../components/ops";
import { addQuery, dateTime, includesQuery, money } from "../lib/format";
import { usePagedResource, useResource } from "../hooks/use-resource";
import type { LedgerEntry, OpsMarket } from "../lib/types";

export default function LedgerPage() {
  const [market, setMarket] = useState("");
  const [account, setAccount] = useState("");
  const [query, setQuery] = useState("");
  const [selectedIdState, setSelectedId] = useState("");
  const markets = useResource<{ markets: OpsMarket[] }>("/ops/api/markets");
  const resource = usePagedResource<LedgerEntry>(addQuery("/ops/api/admin/ledger", { market: market || undefined }), 50);
  const accounts = [...new Set((resource.data?.items ?? []).map((item) => item.account))].sort();
  const items = (resource.data?.items ?? []).filter((item) => (!account || item.account === account) && includesQuery([item.id, item.runId, item.settlementRecordId, item.partyId, item.memo, item.account], query));
  const selectedId = items.some((item) => item.id === selectedIdState) ? selectedIdState : items[0]?.id ?? "";
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const debit = items.reduce((sum, item) => sum + item.debitKobo, 0);
  const credit = items.reduce((sum, item) => sum + item.creditKobo, 0);

  return <div className="page-stack">
    <PageHeader eyebrow="Double-entry record" title="Ledger" description="Trace every debit and credit back to its canonical settlement, run, market, and participant." actions={<RefreshButton loading={resource.loading} onClick={resource.refresh} />} />
    <section className="metric-grid three compact-metrics"><div className="metric-card"><span>Debits on this page</span><strong>{money(debit)}</strong></div><div className="metric-card"><span>Credits on this page</span><strong>{money(credit)}</strong></div><div className="metric-card"><span>Displayed balance</span><strong>{money(debit - credit)}</strong><p>Filtered rows, not a ledger trial balance</p></div></section>
    <section className="filter-bar"><SearchField value={query} onChange={setQuery} placeholder="Entry, settlement, run, party, or memo" /><SelectField label="Market" value={market} onChange={setMarket}><option value="">All markets</option>{markets.data?.markets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectField><SelectField label="Account" value={account} onChange={setAccount}><option value="">Accounts on this page</option>{accounts.map((item) => <option key={item}>{item}</option>)}</SelectField></section>
    <div className="master-detail-layout">
      <section className="record-panel master-panel"><div className="panel-heading"><div><h2>Ledger entries</h2><span>{resource.data?.total ?? 0} entries in the durable record</span></div></div>
        {resource.loading && <LoadingState label="Reading the double-entry ledger…" />}{resource.error && <ErrorState error={resource.error} onRetry={resource.refresh} />}
        {!resource.loading && !resource.error && items.length === 0 && <EmptyState title="No ledger entries found" description="Entries are written with settlement persistence, never by this interface." icon={<BookOpenText size={24} />} />}
        {items.length > 0 && <div className="table-scroll"><table className="data-table"><thead><tr><th>Account</th><th>Party</th><th>Memo</th><th>Debit</th><th>Credit</th><th>Created</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className={selectedId === item.id ? "selected" : ""}><td><button className="record-link" type="button" onClick={() => setSelectedId(item.id)}>{item.account}</button><span className="cell-subtitle">{item.market}</span></td><td>{item.partyId ?? "Platform"}</td><td className="memo-cell">{item.memo}</td><td className="money-cell">{item.debitKobo ? money(item.debitKobo) : "—"}</td><td className="money-cell credit">{item.creditKobo ? money(item.creditKobo) : "—"}</td><td>{dateTime(item.createdAt)}</td></tr>)}</tbody></table></div>}
        <Pager data={resource.data} page={resource.page} setPage={resource.setPage} pageSize={resource.pageSize} />
      </section>
      <aside className="record-panel detail-panel"><div className="panel-heading"><div><p className="overline">Entry provenance</p><h2>Ledger inspector</h2></div>{selected && <StatusBadge status={selected.debitKobo ? "debit" : "credit"} />}</div>
        {!selected && <EmptyState title="Select an entry" description="Choose a ledger row to trace its source." />}
        {selected && <div className="detail-stack"><DetailGrid><DetailRow label="Entry"><CopyValue value={selected.id} display={selected.id} /></DetailRow><DetailRow label="Account">{selected.account}</DetailRow><DetailRow label="Party">{selected.partyId ? <CopyValue value={selected.partyId} /> : "Platform"}</DetailRow><DetailRow label="Market">{selected.market}</DetailRow><DetailRow label="Settlement"><CopyValue value={selected.settlementRecordId} /></DetailRow><DetailRow label="Run"><CopyValue value={selected.runId} /></DetailRow><DetailRow label="Created">{dateTime(selected.createdAt)}</DetailRow><DetailRow label="Amount">{selected.debitKobo ? `${money(selected.debitKobo)} debit` : `${money(selected.creditKobo)} credit`}</DetailRow></DetailGrid><section className="detail-section"><h3>Memo</h3><p className="record-memo">{selected.memo}</p></section><div className="safeguard-note"><BookOpenText size={17} /><p>This read model is derived from persisted settlement records. The dashboard cannot write, edit, or delete ledger entries.</p></div></div>}
      </aside>
    </div>
  </div>;
}
