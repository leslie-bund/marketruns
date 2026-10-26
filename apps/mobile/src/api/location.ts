import * as Location from "expo-location";
import { MAX_LOCATION_ACCURACY_METERS, MAX_LOCATION_AGE_MS } from "@market-runs/domain";
import type { LocationFix } from "@market-runs/proto";

/** One foreground GPS measurement for presence, pool claim and run-action freshness. */
export async function getDeviceLocationFix(): Promise<LocationFix> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) {
    throw new Error("Location permission is required. Enable foreground location and precise GPS, then retry.");
  }
  const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
  const accuracyMeters = position.coords.accuracy ?? Number.POSITIVE_INFINITY;
  const observedAt = position.timestamp;
  if (Date.now() - observedAt > MAX_LOCATION_AGE_MS || observedAt > Date.now() + 5_000) {
    throw new Error("Your GPS fix is stale. Move outdoors, wait for a fresh location, then retry.");
  }
  if (accuracyMeters > MAX_LOCATION_ACCURACY_METERS) {
    throw new Error(`GPS accuracy is ${Math.ceil(accuracyMeters)} m; 100 m or better is required. Enable precise location or move outdoors.`);
  }
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyMeters,
    observedAt,
  };
}

export function locationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
