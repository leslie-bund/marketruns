import { defaultMarketConfig, type MarketConfig } from "../do/schemas.js";

export interface InitialMarketSeed {
  id: string;
  name: string;
  opensAt: string;
  closesAt: string;
  center: { latitude: number; longitude: number };
  radiusMeters: number;
  config: MarketConfig;
}

const DEV_SEED_GEOGRAPHY = {
  Balogun: { latitude: 6.4541, longitude: 3.3947, closesAt: "18:00" },
  "Computer Village": { latitude: 6.5186, longitude: 3.3750, closesAt: "19:00" },
} as const;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function coordinate(args: string[], name: "--latitude" | "--longitude" | "--radius-meters"): number | undefined {
  const raw = option(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  const valid = name === "--latitude" ? value >= -90 && value <= 90
    : name === "--longitude" ? value >= -180 && value <= 180
      : Number.isInteger(value) && value > 0;
  if (!Number.isFinite(value) || !valid) throw new Error(`${name} must be a valid ${name === "--radius-meters" ? "positive integer" : "coordinate"}`);
  return value;
}

/** Built-ins mirror infra/seed-core.mjs; any other market needs explicit geography. */
export function resolveMarketSeeds(args: string[], now: number): InitialMarketSeed[] {
  const names = args.filter((arg, index) => !arg.startsWith("--") && !["--latitude", "--longitude", "--radius-meters"].includes(args[index - 1] ?? ""));
  const requested = names.length > 0 ? names : Object.keys(DEV_SEED_GEOGRAPHY);
  const latitude = coordinate(args, "--latitude");
  const longitude = coordinate(args, "--longitude");
  const radiusMeters = coordinate(args, "--radius-meters");
  const hasExplicitGeo = latitude !== undefined || longitude !== undefined || radiusMeters !== undefined;

  return requested.map((name) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name)) throw new Error(`invalid market name: ${name}`);
    const builtIn = DEV_SEED_GEOGRAPHY[name as keyof typeof DEV_SEED_GEOGRAPHY];
    if (!builtIn && (!hasExplicitGeo || latitude === undefined || longitude === undefined || radiusMeters === undefined)) {
      throw new Error(`market ${name} requires --latitude LAT --longitude LNG --radius-meters METERS`);
    }
    if (hasExplicitGeo && (requested.length !== 1 || latitude === undefined || longitude === undefined || radiusMeters === undefined)) {
      throw new Error("custom geofence flags require exactly one market and all of --latitude, --longitude, --radius-meters");
    }
    const center = hasExplicitGeo
      ? { latitude: latitude!, longitude: longitude! }
      : { latitude: builtIn.latitude, longitude: builtIn.longitude };
    const radius = radiusMeters ?? 750;
    const config = defaultMarketConfig(now, center);
    if (config.geo) {
      config.geo.radiusMeters = radius;
      if (name === "Computer Village") {
        config.geo.exchangePoints = [{ name: "Computer Village, Ola-Ayeni Street, Shop 22", ...center }];
        config.geo.musterPoints = [{ name: "Computer Village Muster Point", ...center }];
      }
    }
    return {
      id: name,
      name,
      opensAt: "08:00",
      closesAt: builtIn?.closesAt ?? "18:00",
      center,
      radiusMeters: radius,
      config,
    };
  });
}
