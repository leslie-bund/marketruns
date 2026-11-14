import { useState } from "react";
import { Clock3, MapPin, Plus, Settings2, ShieldCheck } from "lucide-react";
import ConfirmDialog from "../components/ConfirmDialog";
import MarketConfigDialog from "../components/MarketConfigDialog";
import MarketOnboardingDialog from "../components/MarketOnboardingDialog";
import VocabularyPanel from "../components/VocabularyPanel";
import { ActionNotice, CopyValue, DetailGrid, DetailRow, EmptyState, ErrorState, LoadingState, PageHeader, RefreshButton, SearchField, SelectField, StatusBadge } from "../components/ops";
import { dateTime, distance, duration, includesQuery, money } from "../lib/format";
import { updateMarket } from "../lib/ops-api";
import { useOpsUser } from "../lib/ops-context";
import { useResource } from "../hooks/use-resource";
import type { MarketConfig, OpsMarket } from "../lib/types";

export default function MarketsPage() {
  const user = useOpsUser();
  const resource = useResource<{ markets: OpsMarket[] }>("/ops/api/markets");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [selectedIdState, setSelectedId] = useState("");
  const [onboarding, setOnboarding] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [toggleActive, setToggleActive] = useState(false);
  const [notice, setNotice] = useState("");
  const items = (resource.data?.markets ?? []).filter((market) => (!status || String(market.active) === status) && includesQuery([market.id, market.name], query));
  const selectedId = items.some((market) => market.id === selectedIdState) ? selectedIdState : items[0]?.id ?? "";
  const selected = items.find((market) => market.id === selectedId) ?? null;

  return <div className="page-stack">
    <PageHeader eyebrow="Geographic zones" title="Market management" description="Onboard named zones, control availability, tune operating and settlement configuration, and moderate the vocabulary used for intent matching." actions={<>{user.role !== "viewer" && <button className="primary-button" type="button" onClick={() => setOnboarding(true)}><Plus size={16} />Onboard market</button>}<RefreshButton loading={resource.loading} onClick={resource.refresh} /></>} />
    <ActionNotice message={notice} />
    <section className="filter-bar"><SearchField value={query} onChange={setQuery} placeholder="Market name or registry ID" /><SelectField label="Availability" value={status} onChange={setStatus}><option value="">All markets</option><option value="true">Active</option><option value="false">Inactive</option></SelectField></section>
    <div className="master-detail-layout market-layout">
      <section className="record-panel master-panel"><div className="panel-heading"><div><h2>Market registry</h2><span>{resource.data?.markets.length ?? 0} catalogued zones</span></div></div>{resource.loading && <LoadingState label="Loading market registry…" />}{resource.error && <ErrorState error={resource.error} onRetry={resource.refresh} />}{!resource.loading && !resource.error && items.length === 0 && <EmptyState title="No markets found" description="Onboard a geographic zone or change the current filters." icon={<MapPin size={24} />} />}{items.length > 0 && <div className="market-card-list">{items.map((market) => <button type="button" key={market.id} className={`market-card${selectedId === market.id ? " selected" : ""}`} onClick={() => setSelectedId(market.id)}><div className="market-card-heading"><span className="market-icon"><MapPin size={18} /></span><div><strong>{market.name}</strong><code>{market.id}</code></div><StatusBadge status={market.active} /></div><div className="market-card-facts"><span><Clock3 size={14} />{market.opensAt}–{market.closesAt}</span><span>{distance(market.config?.geo?.radiusMeters ?? market.geofenceRadiusMeters)} radius</span></div><div className="market-card-footer"><span>{market.config ? `Closes ${dateTime(market.config.closeAt)}` : "Configuration needs review"}</span><Settings2 size={15} /></div></button>)}</div>}</section>
      <aside className="record-panel detail-panel"><div className="panel-heading"><div><p className="overline">Zone configuration</p><h2>Market inspector</h2></div>{selected && <StatusBadge status={selected.active} />}</div>{!selected && <EmptyState title="Select a market" description="Choose a market to inspect its geography, hours, rates, and vocabulary." />}{selected && <div className="detail-stack"><div className="detail-title-row"><div><span className="subtle-label">Registry entry</span><h3 className="detail-market-name">{selected.name}</h3><CopyValue value={selected.id} /></div></div><DetailGrid><DetailRow label="Registry hours">{selected.opensAt}–{selected.closesAt}</DetailRow><DetailRow label="Availability"><StatusBadge status={selected.active} /></DetailRow><DetailRow label="Created">{dateTime(selected.createdAt)}</DetailRow><DetailRow label="Updated">{dateTime(selected.updatedAt)}</DetailRow></DetailGrid>
        {selected.config ? <MarketConfigSummary market={selected as OpsMarket & { config: MarketConfig }} /> : <div className="failure-box"><Settings2 size={17} /><div><strong>Configuration unavailable</strong><p>The stored configuration did not validate. Review it through the operational API before reopening this market.</p></div></div>}
        {user.role !== "viewer" && <div className="button-stack">{user.role === "admin" && selected.config && <button className="primary-button full-width" type="button" onClick={() => setConfiguring(true)}><Settings2 size={15} />Edit operational configuration</button>}<button className="secondary-button full-width" type="button" onClick={() => setToggleActive(true)}>{selected.active ? "Deactivate market" : "Reactivate market"}</button></div>}
        <VocabularyPanel market={selected.id} canManage={user.role !== "viewer"} />
      </div>}</aside>
    </div>
    {onboarding && <MarketOnboardingDialog onClose={() => setOnboarding(false)} onCreated={(name) => { setOnboarding(false); setSelectedId(name); setNotice(`${name} was onboarded with launch rates and its mapped geofence.`); resource.refresh(); }} />}
    {configuring && selected?.config && <MarketConfigDialog market={selected as OpsMarket & { config: MarketConfig }} onClose={() => setConfiguring(false)} onSaved={() => { setConfiguring(false); setNotice(`${selected.name} configuration was saved and audited.`); resource.refresh(); }} />}
    {toggleActive && selected && <ConfirmDialog destructive={selected.active} title={`${selected.active ? "Deactivate" : "Reactivate"} ${selected.name}?`} description={selected.active ? "The market becomes unavailable for participant activity. Its stores, runs, disputes, settlements, and durable history are retained." : "The market returns to the active registry using its existing configuration."} confirmLabel={selected.active ? "Deactivate market" : "Reactivate market"} onClose={() => setToggleActive(false)} onConfirm={async () => { await updateMarket(selected.id, { active: !selected.active }); setToggleActive(false); setNotice(`${selected.name} was ${selected.active ? "deactivated" : "reactivated"}.`); resource.refresh(); }} />}
  </div>;
}

function MarketConfigSummary({ market }: { market: OpsMarket & { config: MarketConfig } }) {
  const config = market.config;
  return <section className="detail-section"><div className="detail-section-heading"><h3>Operational configuration</h3>{config.opsConfigured && <StatusBadge status="configured" />}</div><DetailGrid><DetailRow label="Next close">{dateTime(config.closeAt)}</DetailRow><DetailRow label="Checkout gate">{duration(config.estTripMs)} + {duration(config.bufferMs)} buffer</DetailRow><DetailRow label="Center">{config.geo ? `${config.geo.center.latitude.toFixed(6)}, ${config.geo.center.longitude.toFixed(6)}` : "Not configured"}</DetailRow><DetailRow label="Geofence">{distance(config.geo?.radiusMeters)}</DetailRow><DetailRow label="Base floor rate">{money(config.floorRate.baseKobo)}</DetailRow><DetailRow label="Distance / time">{money(config.floorRate.perKilometerKobo)} /km · {money(config.floorRate.perMinuteKobo)} /min</DetailRow><DetailRow label="Floor-rate formula" wide><code>ceil(base + distanceKm × perKm + durationMin × perMinute)</code><span className="cell-subtitle">Fallback example: {money(Math.ceil(config.floorRate.baseKobo + (config.floorRate.distanceMeters / 1000) * config.floorRate.perKilometerKobo + (config.floorRate.estimatedDurationMs / 60000) * config.floorRate.perMinuteKobo))} using the configured fallback route. Checkout substitutes the OSRM route when available.</span></DetailRow><DetailRow label="Goods commission">{(config.settlement.goodsCommissionBps / 100).toFixed(2)}%</DetailRow><DetailRow label="Runner delivery margin">{money(config.settlement.deliveryMarginKobo)}</DetailRow><DetailRow label="Exchange points">{config.geo?.exchangePoints.length ?? 0}</DetailRow><DetailRow label="Muster points">{config.geo?.musterPoints.length ?? 0}</DetailRow></DetailGrid><div className="safeguard-note"><ShieldCheck size={17} /><p>Checkout requires enough time before close for the estimated run plus buffer. Settlement coefficients apply to new runs.</p></div></section>;
}
