# Revenue is commission on goods plus a margin on delivery

The platform earns a percentage commission on the value of accepted products, plus a margin built into the delivery leg (the runner bids X, the buyer pays X plus margin). We rejected flat per-cart fees because they punish small carts, which are the volume base, and goods-only commission because it leaves the platform's unique value — route aggregation and the trust chain — unmonetized.

## Consequences

- The settlement function must split every capture three ways: sellers, runner, platform.
- Muster-point trips monetize through the same delivery margin (a formulaic handling fee), keeping one revenue pipeline.
