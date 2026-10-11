# Markets are geographic zones, not category shards or virtual collectives

A Market is a named geographic zone (a market cluster or LGA) with its own opening and closing times. Product category is a matching attribute inside a market, not a separate market axis. We rejected category-based sharding because it would split a buyer's cart across market boundaries (breaking the one-runner-per-cart rule), and virtual seller collectives because open/close times and short runner trips are physical facts, not group preferences.

## Consequences

- All cart items must belong to one market; cross-market carts are impossible by construction.
- Markets are named zones people already recognize (Balogun, Computer Village), not arbitrary geohash cells. A zone that outgrows what one compute shard can handle is subdivided into smaller zones (Balogun-North, Balogun-South); subdivision is the pressure-release valve, never the default.
- The five-stop cart cap is a business constraint on trip length and does not reduce a zone's compute load; the two are independent.
