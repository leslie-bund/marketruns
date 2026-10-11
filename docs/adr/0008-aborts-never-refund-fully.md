# Aborts never refund fully: runner and platform settle partially

When a buyer aborts a trip — voluntarily or in response to a seller's failed stop — the buyer is not made completely whole. The runner is paid for completed stops plus partial compensation for the disruption, the platform keeps a partial fee, and the buyer receives the remainder. Sellers at completed stops keep their earmarked payouts; a seller whose stop failed is paid nothing and takes a reputation strike.

The reason is anti-abuse, not revenue: full refunds on abort let a seller with fake buyer accounts cycle trades at zero cost (wash trading for reputation and price-signal poisoning), and let buyers abort frivolously at the runner's expense. Abort friction makes abuse cost real money per cycle. The surprising consequence — a buyer whose trip aborts *because a seller flaked* still pays a partial fee — is accepted deliberately; the buyer's remedy against the failed seller is the refund of that product plus the seller's strike, not a free trip.

## Consequences

- The settlement function needs an abort mode with the partial-split rules encoded, not a full-refund shortcut.
- Dispute outcomes that find the platform or a participant at fault can override the friction fee through the normal settlement path.
