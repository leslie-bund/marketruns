import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKET_RADIUS_METERS,
  MAX_LOCATION_ACCURACY_METERS,
  MAX_LOCATION_AGE_MS,
  distanceMeters,
  validateLocationFix,
  validateLocationWithinFence,
} from "../src/geofence.js";

const now = 1_700_000_000_000;
const center = { latitude: 6.4541, longitude: 3.3947 };
const fix = { ...center, accuracyMeters: 10, observedAt: now };
const fence = { center, radiusMeters: DEFAULT_MARKET_RADIUS_METERS };

describe("distanceMeters", () => {
  it("is zero at the same point and symmetric", () => {
    const other = { latitude: 6.4551, longitude: 3.3957 };
    expect(distanceMeters(center, center)).toBe(0);
    expect(distanceMeters(center, other)).toBeCloseTo(distanceMeters(other, center), 8);
    expect(distanceMeters(center, other)).toBeGreaterThan(100);
  });

  it("handles antipodal coordinates without a NaN", () => {
    expect(distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 })).toBeCloseTo(20_015_086, -2);
  });
});

describe("validateLocationFix", () => {
  it("accepts the accuracy and age boundaries", () => {
    expect(validateLocationFix({ ...fix, accuracyMeters: MAX_LOCATION_ACCURACY_METERS, observedAt: now - MAX_LOCATION_AGE_MS }, now)).toMatchObject({ ok: true });
  });

  it("rejects missing, future, inaccurate and stale fixes with actionable codes", () => {
    expect(validateLocationFix(null, now)).toMatchObject({ ok: false, code: "location-required" });
    expect(validateLocationFix({ ...fix, observedAt: now + 60_000 }, now)).toMatchObject({ ok: false, code: "location-invalid" });
    expect(validateLocationFix({ ...fix, accuracyMeters: 100.1 }, now)).toMatchObject({ ok: false, code: "location-inaccurate" });
    expect(validateLocationFix({ ...fix, observedAt: now - 60_001 }, now)).toMatchObject({ ok: false, code: "location-stale" });
  });
});

describe("validateLocationWithinFence", () => {
  it("accepts the center and a point on the perimeter", () => {
    expect(validateLocationWithinFence(fix, fence, now)).toMatchObject({ ok: true, distanceMeters: 0 });
    const boundary = { latitude: center.latitude, longitude: center.longitude + 0.001 };
    const scaledFence = { center, radiusMeters: distanceMeters(center, boundary) };
    expect(validateLocationWithinFence({ ...fix, ...boundary }, scaledFence, now)).toMatchObject({ ok: true });
  });

  it("fails closed outside the perimeter and when the destination is unresolved", () => {
    const outside = { ...fix, latitude: center.latitude + 0.01 };
    expect(validateLocationWithinFence(outside, fence, now)).toMatchObject({ ok: false, code: "location-outside" });
    expect(validateLocationWithinFence(fix, undefined, now)).toMatchObject({ ok: false, code: "location-unresolved" });
  });
});
