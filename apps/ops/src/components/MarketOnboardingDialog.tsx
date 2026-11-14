import { useState, type FormEvent } from "react";
import { Crosshair, MapPin } from "lucide-react";
import { createMarket } from "../lib/ops-api";
import MarketLocationMap from "./MarketLocationMap";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

const DEFAULT_LATITUDE = "6.454100";
const DEFAULT_LONGITUDE = "3.394700";
const DEFAULT_RADIUS = "750";
const MARKET_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

interface MarketOnboardingDialogProps {
  onClose: () => void;
  onCreated: (marketName: string) => void;
}

function validCoordinate(value: number, limit: number) {
  return Number.isFinite(value) && Math.abs(value) <= limit;
}

export default function MarketOnboardingDialog({ onClose, onCreated }: MarketOnboardingDialogProps) {
  const [name, setName] = useState("");
  const [latitude, setLatitude] = useState(DEFAULT_LATITUDE);
  const [longitude, setLongitude] = useState(DEFAULT_LONGITUDE);
  const [radius, setRadius] = useState(DEFAULT_RADIUS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const numericLatitude = Number(latitude);
  const numericLongitude = Number(longitude);
  const numericRadius = Number(radius);
  const mapLatitude = validCoordinate(numericLatitude, 90) ? numericLatitude : Number(DEFAULT_LATITUDE);
  const mapLongitude = validCoordinate(numericLongitude, 180) ? numericLongitude : Number(DEFAULT_LONGITUDE);
  const mapRadius = Number.isInteger(numericRadius) && numericRadius > 0 ? numericRadius : Number(DEFAULT_RADIUS);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!MARKET_NAME.test(trimmedName) || trimmedName.length > 64) {
      setError("Use 1–64 letters, digits, spaces, dots, underscores, or hyphens, starting with a letter or digit.");
      return;
    }
    if (!validCoordinate(numericLatitude, 90) || !validCoordinate(numericLongitude, 180) || !Number.isInteger(numericRadius) || numericRadius <= 0) {
      setError("Enter valid coordinates and a positive whole-metre radius.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      await createMarket({ name: trimmedName, latitude: numericLatitude, longitude: numericLongitude, radiusMeters: numericRadius });
      onCreated(trimmedName);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the market.");
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="market-onboarding">
        <DialogHeader>
          <p className="overline">Market onboarding</p>
          <DialogTitle>Place a new market on the map.</DialogTitle>
          <DialogDescription>Set the market center and the geofence used for presence, claims, and pickups.</DialogDescription>
        </DialogHeader>

        <form className="onboarding-form" onSubmit={(event) => void submit(event)}>
          <div className="onboarding-layout">
            <div className="map-column">
              <MarketLocationMap
                latitude={mapLatitude}
                longitude={mapLongitude}
                radiusMeters={mapRadius}
                onLocationChange={(nextLatitude, nextLongitude) => {
                  setLatitude(nextLatitude.toFixed(6));
                  setLongitude(nextLongitude.toFixed(6));
                }}
              />
              <p className="map-instruction"><Crosshair size={16} />Click the map or drag the marker to set the center.</p>
            </div>

            <div className="onboarding-fields">
              <label htmlFor="market-name">Market name</label>
              <input id="market-name" required maxLength={64} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Computer Village" />

              <div className="coordinate-fields">
                <div>
                  <label htmlFor="market-latitude">Latitude</label>
                  <input id="market-latitude" type="number" required min={-90} max={90} step="0.000001" value={latitude} onChange={(event) => setLatitude(event.target.value)} />
                </div>
                <div>
                  <label htmlFor="market-longitude">Longitude</label>
                  <input id="market-longitude" type="number" required min={-180} max={180} step="0.000001" value={longitude} onChange={(event) => setLongitude(event.target.value)} />
                </div>
              </div>

              <div className="radius-heading">
                <label htmlFor="market-radius">Geofence radius</label>
                <output htmlFor="market-radius market-radius-range">{Number.isFinite(numericRadius) ? `${numericRadius || 0} m` : "Invalid radius"}</output>
              </div>
              <div className="radius-input-wrap">
                <input id="market-radius" type="number" required min={1} max={10000} step={1} value={radius} onChange={(event) => setRadius(event.target.value)} />
                <span>metres</span>
              </div>
              <input
                aria-label="Geofence radius slider"
                id="market-radius-range"
                className="radius-slider"
                type="range"
                min={100}
                max={5000}
                step={50}
                value={Math.min(5000, Math.max(100, mapRadius))}
                onChange={(event) => setRadius(event.target.value)}
              />
              <div className="range-labels"><span>100 m</span><span>5 km</span></div>

              <div className="geography-note"><MapPin size={18} /><p>The shaded circle is the active market boundary. Registry hours start at 08:00–18:00; existing launch rates and settlement defaults are applied.</p></div>
            </div>
          </div>

          {error && <p className="form-error" role="alert">{error}</p>}
          <DialogFooter>
            <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="primary-button onboarding-submit" type="submit" disabled={busy}>{busy ? "Creating market…" : "Create market"}</button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
