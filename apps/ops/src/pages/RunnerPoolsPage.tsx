import { useState } from "react";
import { Pencil, Plus, Trash2, UserMinus, UserPlus, UsersRound } from "lucide-react";
import ConfirmDialog from "../components/ConfirmDialog";
import { ActionNotice, CopyValue, DetailGrid, DetailRow, EmptyState, ErrorState, LoadingState, PageHeader, RefreshButton, SearchField, SelectField, StatusBadge } from "../components/ops";
import { includesQuery } from "../lib/format";
import { addRunner, createRunnerPool, deleteRunnerPool, removeRunner, updateRunnerPool } from "../lib/ops-api";
import { useOpsUser } from "../lib/ops-context";
import { useResource } from "../hooks/use-resource";
import type { OpsMarket, RunnerPool, RunnerPoolMember } from "../lib/types";

export default function RunnerPoolsPage() {
  const user = useOpsUser();
  const resource = useResource<{ items: RunnerPool[] }>("/ops/api/runner-pools");
  const markets = useResource<{ markets: OpsMarket[] }>("/ops/api/markets");
  const [market, setMarket] = useState("");
  const [query, setQuery] = useState("");
  const [selectedIdState, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<RunnerPoolMember | null>(null);
  const [notice, setNotice] = useState("");
  const items = (resource.data?.items ?? []).filter((pool) => (!market || pool.marketId === market) && includesQuery([pool.id, pool.name, pool.marketId, ...pool.members.map((member) => member.runnerId)], query));
  const selectedId = items.some((pool) => pool.id === selectedIdState) ? selectedIdState : items[0]?.id ?? "";
  const selected = items.find((pool) => pool.id === selectedId) ?? null;
  const canManage = user.role !== "viewer";
  const saved = (message: string) => { setCreating(false); setEditing(false); setDeleting(false); setAdding(false); setRemoving(null); setNotice(message); resource.refresh(); };

  return <div className="page-stack">
    <PageHeader eyebrow="Internal delivery supply" title="Runner pools" description="Manage the internal runner associations that guarantee each cart has a floor-rate fulfillment option, including explicit membership." actions={<>{canManage && <button className="primary-button" type="button" onClick={() => setCreating(true)}><Plus size={16} />Create pool</button>}<RefreshButton loading={resource.loading} onClick={resource.refresh} /></>} />
    <ActionNotice message={notice} />
    <section className="filter-bar"><SearchField value={query} onChange={setQuery} placeholder="Pool, market, or runner ID" /><SelectField label="Market" value={market} onChange={setMarket}><option value="">All markets</option>{markets.data?.markets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectField></section>
    <div className="master-detail-layout">
      <section className="record-panel master-panel"><div className="panel-heading"><div><h2>Pool registry</h2><span>{resource.data?.items.length ?? 0} delivery supply groups</span></div></div>{resource.loading && <LoadingState label="Loading runner pools…" />}{resource.error && <ErrorState error={resource.error} onRetry={resource.refresh} />}{!resource.loading && !resource.error && items.length === 0 && <EmptyState title="No runner pools found" description="Create a pool and add internal runners to provide floor-rate delivery supply." icon={<UsersRound size={24} />} />}{items.length > 0 && <div className="pool-grid">{items.map((pool) => <button type="button" key={pool.id} className={`pool-card${selectedId === pool.id ? " selected" : ""}`} onClick={() => setSelectedId(pool.id)}><div><span className="market-icon"><UsersRound size={18} /></span><StatusBadge status={pool.active} /></div><strong>{pool.name}</strong><span>{pool.marketId}</span><footer><span>{pool.members.filter((member) => member.active).length} active runners</span><code>{pool.id}</code></footer></button>)}</div>}</section>
      <aside className="record-panel detail-panel"><div className="panel-heading"><div><p className="overline">Supply & membership</p><h2>Pool inspector</h2></div>{canManage && selected && <div className="inline-actions"><button className="icon-button" type="button" aria-label="Edit pool" onClick={() => setEditing(true)}><Pencil size={15} /></button><button className="icon-button danger-icon" type="button" aria-label="Delete pool" onClick={() => setDeleting(true)}><Trash2 size={15} /></button></div>}</div>{!selected && <EmptyState title="Select a runner pool" description="Choose a pool to inspect availability and membership." />}{selected && <div className="detail-stack"><div className="detail-title-row"><div><span className="subtle-label">{selected.marketId}</span><h3 className="detail-market-name">{selected.name}</h3><CopyValue value={selected.id} /></div><StatusBadge status={selected.active} /></div><DetailGrid><DetailRow label="Market">{selected.marketId}</DetailRow><DetailRow label="Active members">{selected.members.filter((member) => member.active).length}</DetailRow><DetailRow label="Total memberships">{selected.members.length}</DetailRow></DetailGrid>{canManage && <button className="secondary-button full-width" type="button" onClick={async () => { try { await updateRunnerPool(selected.id, { active: !selected.active }); saved(`${selected.name} is now ${selected.active ? "inactive" : "active"}.`); } catch (reason) { setNotice(reason instanceof Error ? reason.message : "Could not update the pool."); } }}>{selected.active ? "Deactivate pool" : "Activate pool"}</button>}<section className="detail-section"><div className="detail-section-heading"><div><h3>Runner membership</h3><p>Claims are atomic; one runner acquires each available run.</p></div>{canManage && <button className="secondary-button compact-button" type="button" onClick={() => setAdding(true)}><UserPlus size={15} />Add runner</button>}</div>{selected.members.length === 0 && <EmptyState title="No runners assigned" description="Add an internal runner by participant ID." />}<div className="member-list">{selected.members.map((member) => <div key={member.runnerId}><span className="operator-avatar small">{member.runnerId.slice(0, 1).toUpperCase()}</span><div><CopyValue value={member.runnerId} display={member.runnerId} /><span>Membership {member.active ? "active" : "inactive"}</span></div><StatusBadge status={member.active} />{canManage && <button className="icon-button danger-icon" type="button" aria-label={`Remove ${member.runnerId}`} onClick={() => setRemoving(member)}><UserMinus size={16} /></button>}</div>)}</div></section></div>}</aside>
    </div>
    {creating && <PoolFormDialog markets={markets.data?.markets ?? []} onClose={() => setCreating(false)} onSaved={(name) => saved(`${name} was created.`)} />}
    {editing && selected && <PoolFormDialog markets={markets.data?.markets ?? []} pool={selected} onClose={() => setEditing(false)} onSaved={(name) => saved(`${name} was updated.`)} />}
    {deleting && selected && <ConfirmDialog destructive title={`Delete ${selected.name}?`} description="Delete this runner pool and its memberships. Historical run assignments and settlements remain unchanged." confirmLabel="Delete pool" onClose={() => setDeleting(false)} onConfirm={async () => { await deleteRunnerPool(selected.id); setSelectedId(""); saved(`${selected.name} was deleted.`); }} />}
    {adding && selected && <AddRunnerDialog pool={selected} onClose={() => setAdding(false)} onSaved={(runner) => saved(`${runner} was added to ${selected.name}.`)} />}
    {removing && selected && <ConfirmDialog destructive title={`Remove ${removing.runnerId}?`} description={`Remove this runner from ${selected.name}. Existing run assignments are not changed.`} confirmLabel="Remove runner" onClose={() => setRemoving(null)} onConfirm={async () => { await removeRunner(selected.id, removing.runnerId); saved(`${removing.runnerId} was removed.`); }} />}
  </div>;
}

function PoolFormDialog({ markets, pool, onClose, onSaved }: { markets: OpsMarket[]; pool?: RunnerPool; onClose: () => void; onSaved: (name: string) => void }) {
  const [name, setName] = useState(pool?.name ?? "");
  const [marketId, setMarketId] = useState(pool?.marketId ?? markets[0]?.id ?? "");
  return <ConfirmDialog title={pool ? `Edit ${pool.name}` : "Create a runner pool"} description="Pools organize internal delivery supply for one market." confirmLabel={pool ? "Save pool" : "Create pool"} onClose={onClose} onConfirm={async () => { if (!name.trim() || !marketId) throw new Error("Pool name and market are required."); if (pool) await updateRunnerPool(pool.id, { name: name.trim(), marketId }); else await createRunnerPool({ name: name.trim(), marketId, active: true }); onSaved(name.trim()); }}><div className="form-stack"><label>Pool name<input autoFocus maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Lagos Island Riders" /></label><label>Market<select value={marketId} onChange={(event) => setMarketId(event.target.value)}><option value="">Choose a market</option>{markets.map((market) => <option key={market.id} value={market.id}>{market.name}</option>)}</select></label></div></ConfirmDialog>;
}

function AddRunnerDialog({ pool, onClose, onSaved }: { pool: RunnerPool; onClose: () => void; onSaved: (runner: string) => void }) {
  const [runner, setRunner] = useState("");
  return <ConfirmDialog title={`Add a runner to ${pool.name}`} description="Adding an existing membership reactivates it. The runner's participant identity is not created here." confirmLabel="Add runner" onClose={onClose} onConfirm={async () => { if (!runner.trim()) throw new Error("Enter a runner participant ID."); await addRunner(pool.id, runner.trim()); onSaved(runner.trim()); }}><label className="dialog-field">Runner participant ID<input autoFocus value={runner} onChange={(event) => setRunner(event.target.value)} placeholder="participant:…" /></label></ConfirmDialog>;
}
