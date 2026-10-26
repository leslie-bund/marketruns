# Revenue is deducted from goods and delivery proceeds

The platform earns a percentage commission on the value of accepted products, plus a margin on the delivery leg. Both are settlement deductions, not customer surcharges: checkout captures goods plus the quoted delivery price, each completed seller receives goods proceeds less commission, and the runner receives gross delivery proceeds less the delivery margin. We rejected flat per-cart fees because they punish small carts, which are the volume base, and goods-only commission because it leaves the platform's unique value — route aggregation and the trust chain — unmonetized.

## Consequences

- The settlement function must split every capture three ways: sellers, runner, platform. Platform revenue is the sum of actual per-seller commissions and the actual runner margin, never an additional capture component.
- Commission is rounded down independently per completed seller leg in integer kobo. Delivery margin is capped at the gross runner payout, so participant payouts cannot become negative and platform credit always has a funding source.
- Muster-point trips monetize through the same delivery-margin deduction (a formulaic handling fee), keeping one revenue pipeline.
