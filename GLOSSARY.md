# Market Runs

An on-demand errand marketplace: buyers post intents, sellers respond with ephemeral offers, and runners aggregate a buyer's accepted offers into a single delivery trip. Nigeria is the launch geography.

## Language

### Participants

**Buyer**:
A person who posts intents, accepts offers, and pays for the full chain (goods + delivery + platform fee).
_Avoid_: customer, user

**Seller**:
A merchant who responds to intents with offers. A seller operates one or more stores.
_Avoid_: vendor, merchant, shop

**Runner**:
A person who executes a Run: collecting all items in a cart from their sellers and delivering them. May be an independent bidder or an internal runner.
_Avoid_: delivery agent, rider, runs person

**Internal Runner**:
A runner engaged by the company itself, guaranteeing that every cart has at least one delivery option at the floor rate. At launch, internal runners are contracted rider associations rather than employees.

### The marketplace

**Market**:
A named geographic zone that locals already recognize (e.g. Balogun, Computer Village), with its own opening and closing times. A cart may only contain products from one market. A zone whose activity outgrows it is subdivided into smaller named zones.

**Store**:
A seller's virtual storefront, registered to a particular market. A seller active in several markets has a store in each. The store's registration determines which market it trades in and which sellers an intent can reach.

**Intent**:
A buyer's expression of demand for specific goods, visible to stores whose shop items match it. An intent carries structured core attributes (item, quantity, price band) and an optional free-text note.
_Avoid_: order, request, bid (buyer-side)

**Price Band**:
The buyer's stated price expectation on an intent. It guides matching and negotiation but never caps an offer; sellers may offer above it and the buyer decides.

**Shop Item**:
A persistent catalog entry inside a store, describing what that store can supply. Shop items are the attributes used to match intents to stores; they inherit their market from the store.
_Avoid_: listing, product (for the persistent sense)

**Product**:
An ephemeral offer created by a seller in response to an intent. It exists only until it is accepted, expired, or withdrawn, and disappears after sale. An unaccepted product dies with its intent, and a product released without sale is retired, never resurrected. A product is accepted exactly once.
_Avoid_: listing, seller bid

**Negotiation**:
The private thread between one buyer and one seller over a single product, in which either side may adjust the price. Only the buyer who posted the intent participates; no other buyers can see or join it.
_Avoid_: auction, bidding war, room

### Fulfillment

**Cart**:
The set of products a buyer has accepted, all belonging to one market, pending checkout. A cart has a single checkout deadline shared by all its products: each new acceptance extends it (up to a fixed ceiling), and on expiry every unbought product retires together.

**Run**:
A single runner's trip collecting every item in one cart from its sellers and delivering them, either to the buyer's location or to a muster point. One runner per cart.
_Avoid_: trip, delivery, dispatch

**Muster Point**:
A fixed location, operated by a partner merchant, where a buyer collects their cart themselves instead of receiving delivery at their own location. The partner is the final exchange point of the run.

**Exchange Point**:
A custody transfer during a run — seller to runner at a pickup, runner to buyer (or muster point) at the end.

**Handoff**:
The confirmation of an exchange point: the runner scans a one-time challenge shown by the other party, photo evidence is captured, and the buyer is notified.
_Avoid_: sign-off, scan

**Settlement**:
The computation performed when a run closes that releases payment to sellers and the runner, applying the rules for completed, partial, aborted, and disputed runs.
_Avoid_: payout, reconciliation

**Trip Auction**:
The short bidding window after a cart locks, in which runners offer prices for the cart's run. The lowest price wins; the floor rate guarantees a taker.

**Floor Rate**:
The formulaic delivery price offered by internal runners, ensuring every cart always has at least one delivery option.

**Reputation**:
A participant's standing, computed by the platform from completed trips, abort rates, and dispute outcomes. Reputation is never based on user-entered ratings.
_Avoid_: star ratings, reviews
