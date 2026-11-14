import { useState } from "react";
import { Activity, ArrowRight, CheckCircle2, CircleX, Clock3, MapPin, RadioTower, Scale, WalletCards } from "lucide-react";
import { Link } from "react-router";
import { useResource } from "../hooks/use-resource";
import { addQuery, bps, dateTime, money, number, relativeTime } from "../lib/format";
import type { AdminRun, Dispute, ListEnvelope, OpsHealth, OpsMarket, Settlement, TelemetryItem } from "../lib/types";
import { EmptyState, ErrorState, LoadingState, PageHeader, RefreshButton, SelectField, StatusBadge } from "../components/ops";

export default function Overview() {
  const markets = useResource<{ markets: OpsMarket[] }>("/ops/api/markets");
  const [selectedMarket, setMarket] = useState("");
  const market = selectedMarket || markets.data?.markets[0]?.id || "";
  const runs = useResource<ListEnvelope<AdminRun>>(addQuery("/ops/api/admin/runs", { kind: "live", market: market || undefined, limit: 6 }));
  const disputes = useResource<ListEnvelope<Dispute>>(addQuery("/ops/api/admin/disputes", { status: "open", limit: 5 }));
  const settlements = useResource<ListEnvelope<Settlement>>(addQuery("/ops/api/admin/settlements", { market: market || undefined, limit: 5 }));
  const telemetry = useResource<{ items: TelemetryItem[] }>(addQuery("/ops/api/telemetry", { market: market || undefined }));
  const health = useResource<OpsHealth>(market ? addQuery("/ops/api/admin/ops-health", { market }) : null);

  const refresh = () => {
    markets.refresh();
    runs.refresh();
    disputes.refresh();
    settlements.refresh();
    telemetry.refresh();
    health.refresh();
  };
  const busy = markets.loading || runs.loading || disputes.loading || settlements.loading || telemetry.loading || health.loading;
  const liveObjects = telemetry.data?.items.filter((item) => item.live).length ?? 0;
  const activeMarkets = markets.data?.markets.filter((item) => item.active).length ?? 0;

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Command center" title="Operations at a glance" description="Monitor live fulfillment, intervention queues, settlement activity, and market readiness from one place." actions={<RefreshButton loading={busy} onClick={refresh} />} />

      <section className="metric-grid four" aria-label="Operational summary">
        <Link to="/runs" className="metric-card"><div><span>Live runs</span><Activity size={18} /></div><strong>{runs.data?.total ?? "—"}</strong><p>Across {market || "all markets"}</p></Link>
        <Link to="/disputes" className="metric-card attention"><div><span>Open disputes</span><Scale size={18} /></div><strong>{disputes.data?.total ?? "—"}</strong><p>Require evidence review</p></Link>
        <Link to="/markets" className="metric-card"><div><span>Active markets</span><MapPin size={18} /></div><strong>{markets.data ? `${activeMarkets}/${markets.data.markets.length}` : "—"}</strong><p>Catalogued geographic zones</p></Link>
        <Link to="/telemetry" className="metric-card"><div><span>Live objects</span><RadioTower size={18} /></div><strong>{telemetry.data ? liveObjects : "—"}</strong><p>Reported in the last 45 seconds</p></Link>
      </section>

      <section className="content-section">
        <div className="section-heading inline"><div><p className="overline">ADR-0013 readiness</p><h2>Market expansion gate</h2><p>Five durable signals determine whether a market is ready to expand.</p></div><SelectField label="Market" value={market} onChange={setMarket}>{(markets.data?.markets ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectField></div>
        {markets.error && <ErrorState title="Could not load the market registry" error={markets.error} onRetry={markets.refresh} />}
        {!markets.error && !market && !markets.loading && <EmptyState title="No market selected" description="Onboard a market to begin measuring operational readiness." />}
        {health.loading && <LoadingState label="Computing durable gate metrics…" />}
        {health.error && <ErrorState title="Expansion metrics unavailable" error={health.error} onRetry={health.refresh} />}
        {health.data && <div className="gate-layout">
          <div className={`gate-verdict${health.data.gate.pass ? " passing" : ""}`}>{health.data.gate.pass ? <CheckCircle2 size={26} /> : <Clock3 size={26} />}<div><span>{health.data.gate.pass ? "Ready to expand" : "Not yet ready"}</span><strong>{health.data.market}</strong><p>Computed {relativeTime(health.data.computedAt)} from archived runs.</p></div></div>
          <div className="gate-metrics">
            <GateMetric label="Qualifying weeks" value={`${health.data.consecutiveQualifyingWeeks}/8`} progress={health.data.consecutiveQualifyingWeeks / 8} pass={health.data.gate.qualifyingWeeks.pass} />
            <GateMetric label="Completed runs" value={`${number(health.data.completedRuns)}/500`} progress={health.data.completedRuns / 500} pass={health.data.gate.completedRuns.pass} />
            <GateMetric label="Dispute rate" value={`${bps(health.data.disputeRateBps)} · target <5%`} progress={health.data.gate.disputeRateBps.pass ? 1 : 500 / Math.max(health.data.disputeRateBps, 1)} pass={health.data.gate.disputeRateBps.pass} inverse />
            <GateMetric label="Zero-touch runs" value={`${bps(health.data.zeroTouchRateBps)}/60%`} progress={health.data.zeroTouchRateBps / 6000} pass={health.data.gate.zeroTouchRateBps.pass} />
            <GateMetric label="Repeat buyers" value={`${health.data.repeatBuyers}/30`} progress={health.data.repeatBuyers / 30} pass={health.data.gate.repeatBuyers.pass} />
          </div>
        </div>}
      </section>

      <div className="overview-columns">
        <section className="content-section">
          <div className="section-heading inline"><div><p className="overline">Intervention queue</p><h2>Open disputes</h2></div><Link className="text-link" to="/disputes">View all<ArrowRight size={14} /></Link></div>
          {disputes.loading && <LoadingState />}
          {disputes.error && <ErrorState error={disputes.error} onRetry={disputes.refresh} />}
          {disputes.data && disputes.data.items.length === 0 && <EmptyState title="No open disputes" description="New disputes will appear here with their evidence and run context." />}
          <div className="compact-record-list">{disputes.data?.items.map((dispute) => <Link to="/disputes" key={dispute.id} className="compact-record"><div><StatusBadge status={dispute.status} /><strong>{dispute.market}</strong><span>{relativeTime(dispute.createdAt)}</span></div><p>{dispute.reason}</p><footer><span>{dispute.evidenceRefs.length} evidence items</span><span>{money(dispute.absorbedLossKobo)} absorbed loss</span></footer></Link>)}</div>
        </section>

        <section className="content-section">
          <div className="section-heading inline"><div><p className="overline">Latest money decisions</p><h2>Recent settlements</h2></div><Link className="text-link" to="/settlements">View all<ArrowRight size={14} /></Link></div>
          {settlements.loading && <LoadingState />}
          {settlements.error && <ErrorState error={settlements.error} onRetry={settlements.refresh} />}
          {settlements.data && settlements.data.items.length === 0 && <EmptyState title="No settlements yet" description="Released settlement decisions will appear here." />}
          <div className="compact-record-list">{settlements.data?.items.map((settlement) => <Link to="/settlements" key={settlement.id} className="compact-record"><div><StatusBadge status={settlement.mode} /><strong>{settlement.market}</strong><span title={dateTime(settlement.releasedAt)}>{relativeTime(settlement.releasedAt)}</span></div><div className="settlement-mini-grid"><span>Goods<strong>{money(settlement.goodsTotalKobo)}</strong></span><span>Runner<strong>{money(settlement.runnerKobo)}</strong></span><span>Platform<strong>{money(settlement.platformKobo)}</strong></span></div></Link>)}</div>
        </section>
      </div>

      <section className="operational-note"><WalletCards size={20} /><div><strong>Settlement remains the only money decision.</strong><p>Dispatch replay, provider sync, and settlement re-drive execute existing decisions. They never create ad-hoc transfers or alter settlement amounts.</p></div><Link to="/payments">Open payments<ArrowRight size={15} /></Link></section>
      {runs.error && <div className="subtle-error"><CircleX size={15} />Live run count unavailable: {runs.error}</div>}
    </div>
  );
}

function GateMetric({ label, value, progress, pass, inverse = false }: { label: string; value: string; progress: number; pass: boolean; inverse?: boolean }) {
  return <div className="gate-metric"><div><span>{label}</span><strong>{value}</strong></div><div className={`progress-track${inverse ? " inverse" : ""}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, Math.max(0, progress)) * 100)}><span style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} /></div><small>{pass ? <><CheckCircle2 size={13} />Passing</> : <><Clock3 size={13} />Below threshold</>}</small></div>;
}
