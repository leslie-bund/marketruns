# Disputes resolve evidence-first, and the platform absorbs ambiguous losses

Disputes are resolved first from the evidence layer (signed photos, scan logs, GPS trail), with human review on appeal within 48 hours; outcomes are always expressed through the settlement function, never ad-hoc transfers. In genuinely ambiguous cases the platform absorbs the loss, capped per case, rather than ruling against one side. This is surprising but deliberate: ruling against buyers in ambiguity costs buyers, ruling against runners costs runners, and a capped absorbed loss is cheaper than either churn — it also makes the evidence layer a profit center, since better evidence shrinks the ambiguous bucket.

## Consequences

- The platform budgets an ambiguity-loss allowance per market. That loss is separately platform-funded; it is not netted against participant-funded commission or margin.
- Confirmed seller legs pay goods proceeds less per-seller commission. The runner's confirmed-fraction payout is reduced by at most the configured delivery margin; with no gross runner payout there is no delivery-margin revenue.
- Every dispute outcome must be representable as inputs to the settlement function; no side-channel refunds. Buyer refund plus all payouts and platform revenue, less the explicit platform loss, must equal the goods-plus-delivery capture.
