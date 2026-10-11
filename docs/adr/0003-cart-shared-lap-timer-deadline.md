# Carts use one shared lap-timer deadline

Buyers assemble carts from several parallel one-to-one negotiations, so acceptances are staggered over many minutes. Per-product reservation timers made early acceptances expire while the buyer was still shopping, evaporating the cart piecemeal. We decided the cart has a single clock: 30 minutes from the first acceptance, extended by 10 minutes on each additional acceptance, with a hard ceiling of 60 minutes. On expiry the whole cart retires atomically; products are never resurrected.

## Consequences

- Every seller's worst-case exposure is one known hour, regardless of cart size.
- The ceiling is what makes the extension safe; without it a large cart could starve early sellers indefinitely.
- Checkout requires the cart clock to be live, not any per-product timer.
