# Market Runs

An on-demand errand marketplace: buyers post intents, sellers respond with ephemeral offers, and runners aggregate a buyer's accepted offers into a single delivery trip. Nigeria is the launch geography.

## Language

### Participants

**Buyer**:
A person who posts intents, accepts offers, and pays for goods + delivery. Goods commission and delivery margin are deducted from seller and runner proceeds at settlement, never added to the buyer's checkout bill.
_Avoid_: customer, user

**Seller**:
A merchant who responds to intents with offers. A seller operates one or more stores.
_Avoid_: vendor, merchant, shop

**Runner**:
A person who executes a Run: collecting all items in a cart from their sellers and delivering them. May be an independent bidder or an internal runner.
_Avoid_: delivery agent, rider, runs person

**Internal Runner**:
A runner engaged by the company itself, guaranteeing that every cart has at least one delivery option at the floor rate. At launch, internal runners are contracted rider associations rather than employees.

**Internal Runner Pool**:
The company's launch delivery supply. Its runners claim available runs atomically, so exactly one runner acquires each run and retries cannot create a second assignment.

### The marketplace

**Market**:
A named geographic zone that locals already recognize (e.g. Balogun, Computer Village), with its own opening and closing times. A cart may only contain products from one market. A zone whose activity outgrows it is subdivided into smaller named zones.

**Store**:
A seller's virtual storefront, registered to a particular market. A seller active in several markets has a store in each. The store's registration determines which market it trades in and which sellers an intent can reach.

**Intent**:
A buyer's expression of demand for specific goods, visible to stores whose shop items match it. An intent carries structured core attributes (item, quantity, price band), an optional free-text note, and an optional reference photo or 15-second-maximum video.
_Avoid_: order, request, bid (buyer-side)

**Price Band**:
The buyer's stated price expectation on an intent. It guides matching and negotiation but never caps an offer; sellers may offer above it and the buyer decides.

**Shop Item**:
A persistent catalog entry inside a store, describing what that store can supply. Shop items are the attributes used to match intents to stores; they inherit their market from the store.
_Avoid_: listing, product (for the persistent sense)

**Product**:
An ephemeral offer created by a seller in response to an intent. It exists only until it is accepted, expired, or withdrawn, and disappears after sale. Its optional photo and 15-second-maximum video become private when the product retires and are retained for a finite support/dispute period. An unaccepted product dies with its intent, and a product released without sale is retired, never resurrected. A product is accepted exactly once.
_Avoid_: listing, seller bid

**Media Hold**:
A documented incident or legal reason that temporarily prevents deletion of a particular retired product's or expired intent's photo or video. It never resurrects the subject, changes a settlement, or applies to unrelated media.
_Avoid_: permanent retention, evidence freeze

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
The confirmation of an exchange point: the runner scans a one-time challenge shown by the other party and attaches photo evidence — the photo is required to confirm; a handoff without it stays pending and is shown to all parties as awaiting photo — and the buyer is notified.
_Avoid_: sign-off, scan

**Settlement**:
The computation performed when a run closes that releases payment to sellers and the runner, applying the rules for completed, partial, aborted, and disputed runs.
_Avoid_: payout, reconciliation

**Dispatch**:
The execution of a settlement's payment legs against payment providers, after the settlement decision. A dispatch carries the settlement record's legs verbatim and never decides money. Reserved for money movement only — never a synonym for a run or delivery.

**Payment Hold**:
A buyer's charge confirmed server-side and held against their cart before checkout (`payment_holds`: held → released | partially-refunded | refunded | failed). When payments are required, a checkout must bind a confirmed hold covering goods plus delivery; a confirmed hold survives a failed checkout and is reusable on retry. Queue execution and successful Ops replay release it only when at least one dispatch row exists and every leg is sent, queued, or completed; pending or failed legs keep it held.

**Refund**:
The return of buyer money decided by the settlement, executed by the payments worker after the decision — by provider refund for card charges, an honest `refund-manual` state for methods the system cannot return money through, or `refund-review` when conflicting provider history blocks safe automatic execution. Ambiguous attempts reconcile against provider history before any retry. Admin resolution records write-once evidence and may accept existing provider/manual refunds or permit canonical retry; it never edits the settlement amount. A refund, like a dispatch, never decides money.
_Avoid_: reversal, chargeback

**Payout Account**:
A seller's saved bank destination for settlement payouts, collected resolve-then-save (bank list → provider account-name lookup → save). Resolution at dispatch is DB-first; selling is never blocked on having one.

**Trip Auction**:
The short bidding window after a cart locks, in which runners offer prices for the cart's run. The lowest price wins; the floor rate guarantees a taker.

**Floor Rate**:
The formulaic delivery price offered by internal runners, ensuring every cart always has at least one delivery option.

**Reputation**:
A participant's standing, computed by the platform from completed trips, abort rates, and dispute outcomes. Reputation is never based on user-entered ratings.
_Avoid_: star ratings, reviews

**Presence**:
A seller's time-bounded availability signal, derived from deduplicated heartbeats and expired when they stop. Presence is not a guarantee that the seller or device is reachable.
_Avoid_: online status (as a guarantee)

### Communication

**Lead**:
A prospective buyer, seller, runner, or partner who has explicitly asked to receive Market Runs launch and onboarding updates. A lead is not a marketplace participant and has not completed identity verification.
_Avoid_: user, account, Smile ID applicant

**Notification**:
A durable in-app record of a marketplace, payment, security, or service event, optionally delivered in real time while connected or by transactional email. A delivery attempt does not replace the durable record or guarantee receipt.
