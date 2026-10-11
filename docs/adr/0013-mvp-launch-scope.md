# MVP launches in one known market, with the auction deferred

The MVP ships in exactly one market — chosen for founder familiarity, Lagos, fresh produce and household staples, dense residential demand within ~3km — and stays there until an ops-health gate is passed (8 consecutive weeks, ≥500 completed trips, <5% dispute rate, ≥60% of trips completing with zero ops intervention, ≥30 repeat buyers).

Day-one delivery is internal runners (contracted rider association) at the floor rate only; the trip auction and gig runner onboarding ship in v2, because there is no gig liquidity to auction among on day one and the auction would be an empty room with extra code. The RunDO and settlement pipeline are built auction-shaped so v2 is an addition, not a rewrite.

Also deferred: steganographic media signing (MVP uses camera-only capture with server-side signing), USSD flows (SMS notifications only, confirmations in-app), user-entered ratings.

Ships at MVP: intents, 1:1 negotiation, ephemeral products, cart with the shared lap-timer, floor-rate delivery and muster points, QR-challenge handoffs with photo evidence, the settlement function with abort/partial rules, computed-metrics reputation, and a minimal ops console whose adjustments are expressed only through the settlement function.

## Consequences

- Everything deferred is an addition to a working core; nothing shipped is a stub that gets replaced.
- The expansion gate measures ops health, not growth; "60% no-touch trips" is the criterion that proves the machine works without founder presence.
