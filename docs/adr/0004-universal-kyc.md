# Every participant is fully KYC-verified, buyers included

Most marketplaces verify sellers and couriers heavily but let buyers in with just a payment instrument. We decided all three roles — buyer, seller, runner — complete full identity verification (BVN-backed) before transacting. The reason is Nigeria-specific: a malicious buyer is a first-class abuse vector (weaponized disputes, fake aborts, collusion with sellers through shared funding instruments), and anonymous demand would undermine the whole handoff-and-settlement trust chain.

## Consequences

- Signup friction for buyers is the accepted cost; mitigation is a verification flow that takes minutes, not a lighter tier.
- The shared-funding collusion check (buyer instrument vs seller payout resolving to the same identity) becomes reliable, because both sides are always identified.
