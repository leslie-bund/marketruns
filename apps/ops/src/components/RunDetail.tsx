import { Camera, CheckCircle2, Clock3, MapPin, PackageCheck, Route } from "lucide-react";
import { dateTime, distance, duration, money, relativeTime } from "../lib/format";
import type { OpsRunDetail } from "../lib/types";
import { CopyValue, DetailGrid, DetailRow, EmptyState, EvidenceList, StatusBadge } from "./ops";

export default function RunDetail({ detail, archivedMessage }: { detail: OpsRunDetail | null; archivedMessage?: string }) {
  if (!detail?.run) {
    return <EmptyState title="Live run detail unavailable" description={archivedMessage ?? "The run may have retired. Its durable record remains available in Archive and Settlements."} icon={<Route size={24} />} />;
  }
  const { run, dispute } = detail;
  return (
    <div className="run-detail">
      <div className="detail-title-row"><div><span className="subtle-label">Run</span><CopyValue value={run.id} display={run.id} /></div><StatusBadge status={run.status} /></div>
      <DetailGrid>
        <DetailRow label="Market">{run.market}</DetailRow>
        <DetailRow label="Floor rate">{money(run.floorRateKobo)}</DetailRow>
        <DetailRow label="Buyer">{run.buyerId ? <CopyValue value={run.buyerId} /> : "—"}</DetailRow>
        <DetailRow label="Runner">{run.runnerId ? <CopyValue value={run.runnerId} /> : "Unassigned"}</DetailRow>
        <DetailRow label="Delivery">{run.delivery.kind === "plus-code" ? run.delivery.plusCode : run.delivery.name}</DetailRow>
        <DetailRow label="Final delivery">{run.finalDeliveryAt ? <span title={dateTime(run.finalDeliveryAt)}>{relativeTime(run.finalDeliveryAt)}</span> : "—"}</DetailRow>
      </DetailGrid>

      {run.route && <div className="route-summary"><Route size={18} /><div><strong>{distance(run.route.distanceMeters)} · {duration(run.route.durationSeconds * 1000)}</strong><span>Cached checkout route across {run.stops.length} collection stops</span></div></div>}

      <section className="detail-section">
        <div className="detail-section-heading"><h3>Collection route</h3><span>{run.stops.filter((stop) => stop.status === "completed").length}/{run.stops.length} complete</span></div>
        <ol className="stop-timeline">{run.stops.map((stop, index) => <li key={`${stop.storeId ?? stop.sellerName}-${index}`} className={stop.status}>
          <div className="timeline-marker">{stop.status === "completed" ? <CheckCircle2 size={17} /> : <MapPin size={17} />}</div>
          <div><strong>{stop.sellerName}</strong><p>{stop.exchangePoint}</p><span>{stop.shopItems.join(" · ")}</span>{stop.legDistanceMeters !== undefined && <small>{distance(stop.legDistanceMeters)} · {duration((stop.legDurationSeconds ?? 0) * 1000)} from previous waypoint</small>}</div>
          <StatusBadge status={stop.status} />
        </li>)}</ol>
      </section>

      <section className="detail-section">
        <div className="detail-section-heading"><h3>Handoff evidence</h3><span>{run.handoffs.filter((handoff) => handoff.status === "confirmed").length}/{run.handoffs.length} confirmed</span></div>
        <div className="handoff-list">{run.handoffs.length === 0 ? <p className="muted-copy">No handoffs have been initiated.</p> : run.handoffs.map((handoff) => <article key={handoff.id} className="handoff-item">
          <div className="handoff-heading"><PackageCheck size={17} /><div><strong>{handoff.type === "pickup" ? "Seller pickup" : "Final delivery"}</strong><span>{handoff.exchangePoint} · {handoff.counterparty}</span></div><StatusBadge status={handoff.awaitingPhoto ? "awaiting" : handoff.status} label={handoff.awaitingPhoto ? "Awaiting photo" : undefined} /></div>
          <div className="handoff-facts"><span><Clock3 size={13} />Requested {relativeTime(handoff.requestedAt)}</span>{handoff.scannedAt && <span>Scanned {dateTime(handoff.scannedAt)}</span>}{handoff.confirmedAt && <span>Confirmed {dateTime(handoff.confirmedAt)}{handoff.autoConfirmed ? " automatically" : ""}</span>}</div>
          {handoff.photoCaptureRef ? <EvidenceList refs={[handoff.photoCaptureRef]} /> : <p className="evidence-warning"><Camera size={14} />No photo evidence attached. This handoff cannot auto-confirm.</p>}
        </article>)}</div>
      </section>

      {dispute && <section className="detail-section dispute-evidence"><div className="detail-section-heading"><h3>Live dispute</h3><StatusBadge status="disputed" /></div><p className="dispute-reason">{dispute.reason}</p><DetailGrid><DetailRow label="Raised by">{dispute.raisedByParticipantId ?? "Anonymous"}</DetailRow><DetailRow label="Evidence items">{dispute.evidenceRefs.length}</DetailRow></DetailGrid><EvidenceList refs={dispute.evidenceRefs} /></section>}
    </div>
  );
}
