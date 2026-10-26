import type { Run } from "@market-runs/proto";

/**
 * Final-delivery destination policy seam. The geofence branch owns the actual
 * coordinate/radius check; this branch deliberately preserves current travel
 * behavior while keeping the check at the single final-delivery gate.
 */
export function finalDeliveryDestinationRefusal(_run: Run): string | null {
  return null;
}
