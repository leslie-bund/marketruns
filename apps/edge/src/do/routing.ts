import { z } from "zod";
import type { GeoPointValue } from "@market-runs/proto";
import type { GeoPoint } from "./schemas.js";

/**
 * OSRM routing, called once at checkout and cached in the RunDO (AGENTS.md
 * stack doctrine). The base URL is env-driven: local dev points at the free
 * public demo server (https://router.project-osrm.org — no key, demo usage
 * policy), production at the self-hosted deployment (infra/osrm). Checkout
 * never blocks on routing: any failure returns null and the caller falls back
 * to the market's static floor-rate inputs.
 */

export interface RouteLeg {
  distanceMeters: number;
  durationSeconds: number;
}

export interface TripRoute {
  distanceMeters: number;
  durationSeconds: number;
  /** One leg per consecutive waypoint pair: runner start → stop 1 → … → delivery. */
  legs: RouteLeg[];
  /** Downsampled path for map display. */
  geometry: GeoPointValue[];
}

const OsrmRouteResponseSchema = z.object({
  code: z.string(),
  routes: z
    .array(
      z.object({
        distance: z.number().nonnegative(),
        duration: z.number().nonnegative(),
        legs: z.array(
          z.object({
            distance: z.number().nonnegative(),
            duration: z.number().nonnegative(),
          }),
        ),
        geometry: z.object({
          coordinates: z.array(z.tuple([z.number(), z.number()])),
        }),
      }),
    )
    .min(1),
});

const TIMEOUT_MS = 8_000;
/** Cap the cached polyline — market trips are short; ~120 points renders identically. */
const MAX_GEOMETRY_POINTS = 120;

function downsample(points: GeoPointValue[]): GeoPointValue[] {
  if (points.length <= MAX_GEOMETRY_POINTS) return points;
  const step = Math.ceil(points.length / MAX_GEOMETRY_POINTS);
  const sampled = points.filter((_, index) => index % step === 0);
  const last = points[points.length - 1]!;
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

async function fetchRoute(url: string): Promise<TripRoute | null> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // The public demo server 403s requests without an identifying UA (usage policy).
    headers: { "user-agent": "market-runs-dev/0.1 (local dev)" },
  });
  if (!response.ok) {
    console.warn(`[routing] OSRM HTTP ${response.status} — checkout falls back to static estimates`);
    return null;
  }
  const parsed = OsrmRouteResponseSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.code !== "Ok") {
    console.warn(`[routing] OSRM payload rejected — checkout falls back to static estimates`);
    return null;
  }
  const route = parsed.data.routes[0]!;
  return {
    distanceMeters: route.distance,
    durationSeconds: route.duration,
    legs: route.legs.map((leg) => ({ distanceMeters: leg.distance, durationSeconds: leg.duration })),
    geometry: downsample(route.geometry.coordinates.map(([longitude, latitude]) => ({ latitude, longitude }))),
  };
}

export async function routeTrip(
  baseUrl: string,
  waypoints: Array<Omit<GeoPoint, "name">>,
): Promise<TripRoute | null> {
  if (waypoints.length < 2) return null;
  const coordinates = waypoints.map((point) => `${point.longitude},${point.latitude}`).join(";");
  const url = `${baseUrl.replace(/\/$/, "")}/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`;
  // The free demo server flakes under rate limiting — one retry before fallback.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const route = await fetchRoute(url);
      if (route !== null || attempt === 1) return route;
    } catch (error) {
      // Unreachable / timed out / DNS — retry once, then static estimates.
      console.warn(`[routing] OSRM attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}
