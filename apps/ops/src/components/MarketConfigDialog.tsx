import { useState, type FormEvent } from "react";
import { MapPin, Settings2 } from "lucide-react";
import MarketLocationMap from "./MarketLocationMap";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { updateMarketConfig } from "../lib/ops-api";
import type { MarketConfig, OpsMarket } from "../lib/types";

function localInput(timestamp: number): string {
  const date = new Date(timestamp);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function MarketConfigDialog({ market, onClose, onSaved }: { market: OpsMarket & { config: MarketConfig }; onClose: () => void; onSaved: () => void }) {
  const [config, setConfig] = useState<MarketConfig>(() => structuredClone(market.config));
  const [closeAt, setCloseAt] = useState(() => localInput(market.config.closeAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const geo = config.geo ?? { center: { latitude: market.centerLatitude ?? 6.4541, longitude: market.centerLongitude ?? 3.3947 }, radiusMeters: market.geofenceRadiusMeters ?? 750, exchangePoints: [], musterPoints: [] };

  const update = (next: (current: MarketConfig) => MarketConfig) => setConfig((current) => next(current));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const timestamp = new Date(closeAt).getTime();
    if (!Number.isFinite(timestamp)) {
      setError("Choose a valid market close time.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await updateMarketConfig(market.id, { ...config, closeAt: timestamp, geo });
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Market configuration could not be saved.");
      setBusy(false);
    }
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent className="market-config-dialog"><DialogHeader><div className="dialog-symbol"><Settings2 size={20} /></div><DialogTitle>Configure {market.name}</DialogTitle><DialogDescription>Changes are validated by the edge, written to MarketDO and Postgres, and recorded in the operator audit.</DialogDescription></DialogHeader><form onSubmit={(event) => void submit(event)}>
    <div className="config-layout"><div><MarketLocationMap latitude={geo.center.latitude} longitude={geo.center.longitude} radiusMeters={geo.radiusMeters} onLocationChange={(latitude, longitude) => update((current) => ({ ...current, geo: { ...geo, center: { latitude, longitude } } }))} /><p className="map-instruction"><MapPin size={15} />Click or drag to move the market center. Geofence changes apply to presence, claims, and pickups.</p><div className="form-grid three"><label>Latitude<input type="number" required min={-90} max={90} step="0.000001" value={geo.center.latitude} onChange={(event) => update((current) => ({ ...current, geo: { ...geo, center: { ...geo.center, latitude: Number(event.target.value) } } }))} /></label><label>Longitude<input type="number" required min={-180} max={180} step="0.000001" value={geo.center.longitude} onChange={(event) => update((current) => ({ ...current, geo: { ...geo, center: { ...geo.center, longitude: Number(event.target.value) } } }))} /></label><label>Radius (metres)<input type="number" required min={1} step={1} value={geo.radiusMeters} onChange={(event) => update((current) => ({ ...current, geo: { ...geo, radiusMeters: Number(event.target.value) } }))} /></label></div></div>
      <div className="config-fields"><section><h3>Operating window</h3><label>Next close<input type="datetime-local" required value={closeAt} onChange={(event) => setCloseAt(event.target.value)} /></label><div className="form-grid two"><label>Estimated run (minutes)<input type="number" required min={0} value={Math.round(config.estTripMs / 60_000)} onChange={(event) => update((current) => ({ ...current, estTripMs: Number(event.target.value) * 60_000 }))} /></label><label>Close buffer (minutes)<input type="number" required min={0} value={Math.round(config.bufferMs / 60_000)} onChange={(event) => update((current) => ({ ...current, bufferMs: Number(event.target.value) * 60_000 }))} /></label></div></section><section><h3>Floor rate</h3><div className="form-grid two"><label>Base fare (₦)<input type="number" required min={0} step="0.01" value={config.floorRate.baseKobo / 100} onChange={(event) => update((current) => ({ ...current, floorRate: { ...current.floorRate, baseKobo: Math.round(Number(event.target.value) * 100) } }))} /></label><label>Per kilometre (₦)<input type="number" required min={0} step="0.01" value={config.floorRate.perKilometerKobo / 100} onChange={(event) => update((current) => ({ ...current, floorRate: { ...current.floorRate, perKilometerKobo: Math.round(Number(event.target.value) * 100) } }))} /></label><label>Per minute (₦)<input type="number" required min={0} step="0.01" value={config.floorRate.perMinuteKobo / 100} onChange={(event) => update((current) => ({ ...current, floorRate: { ...current.floorRate, perMinuteKobo: Math.round(Number(event.target.value) * 100) } }))} /></label><label>Fallback distance (km)<input type="number" required min={0} step="0.1" value={config.floorRate.distanceMeters / 1000} onChange={(event) => update((current) => ({ ...current, floorRate: { ...current.floorRate, distanceMeters: Number(event.target.value) * 1000 } }))} /></label><label>Fallback duration (minutes)<input type="number" required min={0} value={Math.round(config.floorRate.estimatedDurationMs / 60_000)} onChange={(event) => update((current) => ({ ...current, floorRate: { ...current.floorRate, estimatedDurationMs: Number(event.target.value) * 60_000 } }))} /></label></div></section><section><h3>Settlement coefficients</h3><div className="form-grid two"><label>Goods commission (%)<input type="number" required min={0} max={100} step="0.01" value={config.settlement.goodsCommissionBps / 100} onChange={(event) => update((current) => ({ ...current, settlement: { ...current.settlement, goodsCommissionBps: Math.round(Number(event.target.value) * 100) } }))} /></label><label>Runner delivery margin (₦)<input type="number" required min={0} step="0.01" value={config.settlement.deliveryMarginKobo / 100} onChange={(event) => update((current) => ({ ...current, settlement: { ...current.settlement, deliveryMarginKobo: Math.round(Number(event.target.value) * 100) } }))} /></label></div><p className="field-help">Settlement coefficient changes apply to new runs; existing durable decisions are never rewritten.</p></section></div></div>
    {error && <p className="form-error" role="alert">{error}</p>}<DialogFooter><button className="secondary-button" type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving configuration…" : "Save configuration"}</button></DialogFooter>
  </form></DialogContent></Dialog>;
}
