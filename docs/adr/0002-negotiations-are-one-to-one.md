# Negotiations are strictly one buyer to one seller

A product (ephemeral seller offer) is negotiated only between the selling seller and the buyer who posted the intent. Other buyers cannot see or counter-bid on it. We rejected the multi-buyer auction reading of the original design because it opens a manipulation hole (fake buyer accounts bidding prices up) that disappears entirely when there is no buyer-vs-buyer bidding, and because "product disappears after sale" is simpler to honour with exactly one potential acceptor.

## Considered Options

- Open auction among buyers on each seller offer — rejected: enables bid-up manipulation, complicates the accept-once guarantee, and conflicts with the inDrive-style direct-negotiation model the design is based on.
