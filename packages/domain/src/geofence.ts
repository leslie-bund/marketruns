export const DEFAULT_MARKET_RADIUS_METERS = 750;
export const MAX_LOCATION_ACCURACY_METERS = 100;
export const MAX_LOCATION_AGE_MS = 60_000;
const MAX_FUTURE_SKEW_MS = 5_000;
const EARTH_RADIUS_METERS = 6_371_008.8;

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** The latest device fix only; no location history is part of the domain contract. */
export interface LocationFix extends GeoPoint {
  accuracyMeters: number;
  observedAt: number;
}

export interface GeoFence {
  center: GeoPoint;
  radiusMeters: number;
}

export type LocationRefusalCode =
  | "location-required"
  | "location-invalid"
  | "location-inaccurate"
  | "location-stale"
  | "location-outside"
  | "location-unresolved";

export type LocationCheck =
  | { ok: true; distanceMeters: number }
  | { ok: false; code: LocationRefusalCode; message: string };

/** Great-circle distance using the haversine formula, with antipodal inputs clamped safely. */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function validateLocationFix(fix: LocationFix | null | undefined, now: number): LocationCheck {
  if (!fix) return { ok: false, code: "location-required", message: "Share a current GPS location before this action." };
  if (![fix.latitude, fix.longitude, fix.accuracyMeters, fix.observedAt].every(Number.isFinite) ||
      Math.abs(fix.latitude) > 90 || Math.abs(fix.longitude) > 180 || fix.accuracyMeters < 0) {
    return { ok: false, code: "location-invalid", message: "The GPS location is invalid. Acquire a new fix and retry." };
  }
  if (fix.observedAt > now + MAX_FUTURE_SKEW_MS) {
    return { ok: false, code: "location-invalid", message: "The GPS timestamp is in the future. Check the device clock and acquire a new fix." };
  }
  if (now - fix.observedAt > MAX_LOCATION_AGE_MS) {
    return { ok: false, code: "location-stale", message: "The GPS location is over 60 seconds old. Acquire a fresh fix and retry." };
  }
  if (fix.accuracyMeters > MAX_LOCATION_ACCURACY_METERS) {
    return { ok: false, code: "location-inaccurate", message: `GPS accuracy is ${Math.ceil(fix.accuracyMeters)} m; 100 m or better is required. Move outdoors or enable precise location.` };
  }
  return { ok: true, distanceMeters: 0 };
}

/** Pure enforcement seam shared by market presence, pool claims, pickup and final delivery. */
export function validateLocationWithinFence(
  fix: LocationFix | null | undefined,
  fence: GeoFence | null | undefined,
  now: number,
): LocationCheck {
  const valid = validateLocationFix(fix, now);
  if (!valid.ok) return valid;
  if (!fence || !Number.isFinite(fence.radiusMeters) || fence.radiusMeters <= 0) {
    return { ok: false, code: "location-unresolved", message: "The enforcement destination has no resolved coordinate. Ops must configure it before this action." };
  }
  const distance = distanceMeters(fix!, fence.center);
  if (distance > fence.radiusMeters) {
    return { ok: false, code: "location-outside", message: `You are ${Math.ceil(distance)} m from the required location, outside the ${fence.radiusMeters} m perimeter.` };
  }
  return { ok: true, distanceMeters: distance };
}
