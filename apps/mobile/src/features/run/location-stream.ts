import { useEffect, useRef, useState } from "react";
import * as Location from "expo-location";
import { locationTick } from "../../api";

/** Doctrine: the location stream is throttled fire-and-forget (confirmations are the must-arrive counterpart). */
const MIN_INTERVAL_MS = 10_000;
const MIN_DISTANCE_M = 25;

/**
 * The runner's live location: real device GPS (expo-location) streamed to the
 * RunDO while a run id is given (null = not sharing). Failures surface as an error string so the UI can
 * fall back to the manual dev tick on simulators without a location source.
 */
export function useRunnerLocationStream(runId: string | null): { sharing: boolean; error: string | null } {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSentAt = useRef(0);

  useEffect(() => {
    if (!runId) {
      setSharing(false);
      return undefined;
    }
    let subscription: Location.LocationSubscription | null = null;
    let cancelled = false;

    (async () => {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        if (!cancelled) setError("Location permission is required for claims, pickups and delivery. Enable foreground precise location.");
        return;
      }
      subscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Highest,
          timeInterval: MIN_INTERVAL_MS,
          distanceInterval: MIN_DISTANCE_M,
        },
        (fix) => {
          const now = Date.now();
          if (now - lastSentAt.current < MIN_INTERVAL_MS) return; // throttle belt-and-braces
          lastSentAt.current = now;
          // Fire-and-forget: a dropped fix is fine, the next one supersedes it.
          locationTick(runId, fix.coords.latitude, fix.coords.longitude, fix.coords.accuracy ?? Number.POSITIVE_INFINITY)
            .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
        },
      );
      if (!cancelled) {
        setSharing(true);
        setError(null);
      }
    })().catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });

    return () => {
      cancelled = true;
      subscription?.remove();
      setSharing(false);
    };
  }, [runId]);

  return { sharing, error };
}
