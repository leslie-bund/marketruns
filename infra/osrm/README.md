# OSRM routing

Routing is called once at checkout and the result is cached in the RunDO (per-stop legs + trip totals drive the Floor Rate and the stop ETAs).

## Deviation in local dev

The stack doctrine is **self-hosted OSRM** (AGENTS.md). For local development the edge instead points at the free public demo server — `https://router.project-osrm.org`, no key, demo usage policy — via the `OSRM_BASE_URL` var in `infra/wrangler.edge.toml`. The demo server only carries the global driving profile and offers no SLA; that is acceptable for dev because checkout never blocks on routing: any failure falls back to the market's static floor-rate estimates (`MarketConfig.floorRate`).

Production must use the self-hosted deployment below and set `OSRM_BASE_URL` accordingly. This directory remains the placeholder for that deployment.

## Coordinates

Stop and delivery names resolve through `MarketConfig.geo` (market center, named exchange points, named muster points). Buyer plus-code delivery decodes via the pure `plusCodeToLocation` in `@market-runs/domain` — short codes recover against the market center.
