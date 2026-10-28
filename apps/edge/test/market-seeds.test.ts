import { describe, expect, it } from "vitest";
import { resolveMarketSeeds } from "../src/ops-console/market-seeds.js";

const NOW = 1_700_000_000_000;

describe("initial ops market seeds", () => {
  it("matches the dev seed centers and radii in both registry and runtime config", () => {
    const seeds = resolveMarketSeeds([], NOW);
    expect(seeds.map((seed) => ({
      id: seed.id,
      center: seed.center,
      radiusMeters: seed.radiusMeters,
      configCenter: seed.config.geo?.center,
      configRadius: seed.config.geo?.radiusMeters,
      closesAt: seed.closesAt,
    }))).toEqual([
      {
        id: "Balogun", center: { latitude: 6.4541, longitude: 3.3947 }, radiusMeters: 750,
        configCenter: { latitude: 6.4541, longitude: 3.3947 }, configRadius: 750, closesAt: "18:00",
      },
      {
        id: "Computer Village", center: { latitude: 6.5186, longitude: 3.3750 }, radiusMeters: 750,
        configCenter: { latitude: 6.5186, longitude: 3.3750 }, configRadius: 750, closesAt: "19:00",
      },
    ]);
    expect(seeds[1]?.config.geo?.exchangePoints[0]?.name).toContain("Computer Village");
  });

  it("requires complete explicit geography for a custom market", () => {
    expect(() => resolveMarketSeeds(["Yaba"], NOW)).toThrow(/requires --latitude/);
    expect(() => resolveMarketSeeds(["Yaba", "--latitude", "6.5"], NOW)).toThrow(/requires --latitude/);
    const [seed] = resolveMarketSeeds(["Yaba", "--latitude", "6.5", "--longitude", "3.38", "--radius-meters", "900"], NOW);
    expect(seed).toMatchObject({
      id: "Yaba", center: { latitude: 6.5, longitude: 3.38 }, radiusMeters: 900,
      config: { geo: { center: { latitude: 6.5, longitude: 3.38 }, radiusMeters: 900 } },
    });
  });
});
