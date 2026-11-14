# Carts and runs key on the participant identity, and the dev-stage seam becomes load-bearing

Until now a market had exactly one open cart: `cart:<market>` was a deliberate dev shortcut — one shared cart per market "until participant identity lands". ADR-0016 landed the dev-stage identity (the app onboards, then attaches `x-participant-id` / `x-participant-role` on every call), so the shortcut came due. This ADR records the four decisions that landed together: per-buyer cart and run keying, the close-gate rollover the dev phase needed, runner run discovery, and the dispute/delivery fields added to the run wire. The common thread is that ADR-0015's header seam now carries real weight: id keying, acceptance attribution, and run discovery all resolve through it, so it is load-bearing rather than a passive fallback.

## Carts and runs are per buyer; the edge is authoritative for the ids

Cart ids are `cart:<market>:<buyerId>`; the run stays 1:1 with its cart, so `run:<cartId>` is per-buyer automatically. The derivation lives in one place (`apps/edge/src/config/ids.ts`) and **the edge is the only authority**: clients never derive ids. A buyer learns their cart id from the accept response (`cart.updated.cart.id`) or re-discovers it with the header-keyed `GET /markets/:market/cart` (404 when the caller has no open cart in that market); checkout sends the edge-issued id back.

The buyer identity behind an accept resolves in order: the header-resolved caller, else the intent's recorded buyer, else `buyer:anonymous`. The last branch is deliberate continuity — anonymous, header-less flows collapse into one shared anonymous cart per market, which behaves exactly like the old `cart:<market>`, so unonboarded exploration keeps working. CartDO refuses cross-buyer checkout with 409: the id on `checkout.requested` must be this cart's id, and the buyer must be this cart's buyer.

**Acceptance attribution is enforced.** The resolution order above decides both *who may accept* and *whose cart* receives the product. A different identified buyer receives 403 before accept-once state or cart state changes; the originating buyer can still accept afterward. Only the explicitly gated header-auth demo may use header-less inheritance, so unonboarded exploration keeps working without creating a deployed bypass; deployed acceptance requires a buyer session. ProductDO also checks the unaccepted product's expiry synchronously at accept time, closing the pre-alarm post-TTL window; accepted products retain `already-accepted` replay precedence because the cart clock then owns retirement.

## The close gate rolls forward for auto-generated configs only

Default market configs are generated with `closeAt = now + 8h` (the constant `MARKET_OPEN_WINDOW_MS`). A lapsed `closeAt` would refuse every checkout forever — fatal for a dev/stage phase (ADR-0013) where nobody operates the markets daily. So the choke point `MarketDO.config()` lazily rolls an expired auto-generated config forward by one open window, persists, and continues as open.

Ops-written configs (every `POST /config` write sets `opsConfigured: true`) never roll: an ops-closed market stays closed. The rollover is dev-stage doctrine, tied to ADR-0013's phase; when markets gain real operators it is revisited, not silently kept. *[Amended: the unwritten `MARKET_CONFIG` KV seed path was removed; ops writes live in MarketDO storage and Postgres, with registry geography and defaults used only when no DO config exists.]*

## Runner run discovery reads the live-run index, and degrades honestly

DOs are never enumerated (ADR-0017), so a runner asking "what am I running" cannot ask the DOs. The new client-safe `GET /markets/:market/runs/active` resolves the caller through the participant seam and queries the archive's `/admin/runs` — which gained the additive `runnerId` and `kind=live|archived` filters for exactly this — returning `{ runs: [{runId, market, status, buyerId, startedAt, stopCount}], warning? }`.

Two recorded postures:

- **The index is not doctrine.** `live_runs` is ADR-0017's enumeration aid; when the archive is unreachable or answers badly the route degrades to `{ runs: [], warning }` so the runner screen keeps working on its own stored run id. The index is written at run start and retirement only, so `status` can lag (a run reads `assigned` while already delivering) — cosmetic, never a money input.
- **MVP runner visibility.** Every run at MVP is assigned to `runner:internal` (ADR-0013), so the runner-identified caller — the app's internal-runner identity — sees every live run in the market. The route filters by the caller's own id; "sees all" is the consequence of one shared runner id, not an unfiltered read. The trip auction (v2) is what introduces per-runner assignment.

## The run wire carries dispute state and the final-delivery stamp

`RunSchema` (`packages/proto`) gained three additive optional fields: `disputed`, `disputeRaisedByParticipantId`, and `finalDeliveryAt`. Dispute state lives on RunState rather than inside the stored run, so RunDO merges it into the wire shape at a single point, `wireRun()`, which all twelve `run.updated` emission sites already funnel through — no emission site was left behind. Older clients ignore the new fields.

Disputes are attributed: the edge adopts the header-resolved caller as `raisedByParticipantId` (ADR-0015's seam again); anonymous callers still dispute, recorded as `null`. `finalDeliveryAt` is what makes the 30-minute dispute window (ADR-0007) countable on the client — the buyer's dispute affordance counts down from the stamp, not from a guess.

## Seller run discovery rides the same index

`run.started` gained `storeIds` — the cart's distinct store references at checkout (Products carry the store's trading identity as `sellerName`, the same textual reference `archived_products.store_id` records) — and `live_runs` gained a matching `store_ids` text array, so a seller-identified caller on `GET /markets/:market/runs/active` sees live runs containing their store via the additive `storeId` filter on the archive's `/admin/runs`. The posture is identical to runner discovery: the index is not doctrine, the route degrades to `{ runs: [], warning }`, and the mobile seller surfaces follow the stored-id-wins-then-discovery pattern. One honest caveat: the store registry records no owner participant id, so the caller's store arrives as a client-asserted `storeId` query param under the same dev-stage header seam — the seller→store mapping becomes server-side truth when real auth lands, and the param goes away.

Disputes are attributed: the edge adopts the header-resolved caller as `raisedByParticipantId` (ADR-0015's seam again); anonymous callers still dispute, recorded as `null`. `finalDeliveryAt` is what makes the 30-minute dispute window (ADR-0007) countable on the client — the buyer's dispute affordance counts down from the stamp, not from a guess.

## Consequences

- One open cart per buyer per market; anonymous flows share the anonymous cart and behave as before. Mobile keeps edge-issued ids in its cart-state store and never derives them.
- ADR-0015's seam is now load-bearing — cart/run keying, dispute attribution, and run discovery all depend on the identity it resolves. This sharpens, but does not change, the swap surface: still `resolveParticipant` alone.
- Acceptance is restricted to the intent's buyer and to unexpired products at the ProductDO command boundary; discovery scope is no longer the only enforcement, and the header-less demo fallback is preserved explicitly.
- The close-gate rollover and runner-sees-all visibility are dev-stage postures tied to ADR-0013's phase; both are revisited when markets gain operators and the trip auction ships.
- The archive contract grows the `runnerId`/`kind` filters additively; the live-run index's staleness and unavailability are tolerated by design, never papered over.
