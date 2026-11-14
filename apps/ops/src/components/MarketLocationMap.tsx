import { useEffect } from "react";
import { Icon, latLng } from "leaflet";
import { Circle, MapContainer, Marker, TileLayer, useMap, useMapEvents } from "react-leaflet";
import markerIconRetinaUrl from "leaflet/dist/images/marker-icon-2x.png";
import markerIconUrl from "leaflet/dist/images/marker-icon.png";
import markerShadowUrl from "leaflet/dist/images/marker-shadow.png";
import "leaflet/dist/leaflet.css";

const markerIcon = new Icon({
  iconUrl: markerIconUrl,
  iconRetinaUrl: markerIconRetinaUrl,
  shadowUrl: markerShadowUrl,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

interface MarketLocationMapProps {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  onLocationChange: (latitude: number, longitude: number) => void;
}

function LocationEvents({ onLocationChange }: Pick<MarketLocationMapProps, "onLocationChange">) {
  useMapEvents({
    click(event) {
      onLocationChange(event.latlng.lat, event.latlng.lng);
    },
  });
  return null;
}

function FitGeofence({ latitude, longitude, radiusMeters }: Omit<MarketLocationMapProps, "onLocationChange">) {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(latLng(latitude, longitude).toBounds(radiusMeters * 2), {
      animate: false,
      maxZoom: 16,
      padding: [28, 28],
    });
  }, [latitude, longitude, map, radiusMeters]);
  return null;
}

export default function MarketLocationMap({ latitude, longitude, radiusMeters, onLocationChange }: MarketLocationMapProps) {
  const center: [number, number] = [latitude, longitude];
  return (
    <div className="market-map-wrap" role="group" aria-label="Market location and geofence map">
      <MapContainer className="market-map" center={center} zoom={15} scrollWheelZoom worldCopyJump>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <LocationEvents onLocationChange={onLocationChange} />
        <FitGeofence latitude={latitude} longitude={longitude} radiusMeters={radiusMeters} />
        <Circle center={center} radius={radiusMeters} pathOptions={{ color: "#176345", fillColor: "#d8ef72", fillOpacity: 0.24, weight: 2 }} />
        <Marker
          draggable
          icon={markerIcon}
          position={center}
          eventHandlers={{
            dragend(event) {
              const next = event.target.getLatLng();
              onLocationChange(next.lat, next.lng);
            },
          }}
        />
      </MapContainer>
    </div>
  );
}
