# Durable identities, archive persistence, reputation, and the ops console land for the MVP

Four gaps stood between the codebase and the ADR-0013 MVP scope: retirement payloads carried no durable identities (the archive consumer dead-lettered everything), computed-metrics reputation had no implementation, there was no ops console, and the archive consumer itself was a stub. This ADR records how each was closed.

## Durable identities on the wire (until auth lands)

The client wire still has no participant authentication (a documented proto gap). Rather than block the archive records on it, identity fields were added as **optional, client-supplied values**: `intent.posted.buyerId`, `checkout.requested.buyerId`. The edge echoes them onto intents, products, runs, settlements, and retirement snapshots; when absent, the system anchors records to `buyer:anonymous` and `runner:internal` (MVP has exactly one internal runner pool). These fields are audit attribution, not authorization — anyone can still claim any id — and are replaced by the identity layer when it ships. Settlement legs, the ledger capture, and reputation keys all use them, so the durable record is complete for honest clients today and upgradeable without a migration.

## Archive persistence and the relaxed foreign keys

The archive consumer now persists every retirement event: `run.retired` → `runs_archive`, `settlement.released` → `settlement_records` + balanced double-entry `ledger_entries` (via `settlementLegs`), `product.retired` → `archived_products`, `cart.retired` → R2 (`snapshots/carts/…`, there is no carts table). All ids are deterministic and all inserts are `ON CONFLICT DO NOTHING`, so queue redelivery replays as a no-op. The settlement event carries its full `SettlementInput` verbatim so the durable record shows exactly what was computed.

Migration 0001 drops three foreign keys — `archived_products.store_id`, `archived_products.market_id`, `runs_archive.market_id` — and makes `archived_products.buyer_id` nullable. The stores/markets anchoring is a founder-decision item (schema README) and the edge knows only seller display names and market strings; the archive records these references verbatim. The FKs return when the anchor tables have writers. A parse fix at the consumer boundary accepts the JSON-string queue bodies the DOs actually send.

## Computed-metrics reputation

Reputation is a pure domain function (`packages/domain/src/reputation.ts`) over `ReputationFact` rows — completed trips, aborts, dispute outcomes, seller failed stops (a strike, ADR-0008), disputes lost. Standing starts at 10 000 bps; each abort costs 2 000, each strike 1 500, floored at 0. It is a gate signal, not a ranking, and never uses user-entered ratings. The archive service computes it at read time from `runs_archive` + `settlement_records.inputs` and exposes `GET /reputation?participant=…&role=…`; the ops console proxies that endpoint.

## The ops console adjusts only through the settlement function

`GET /ops` serves a minimal console (embedded HTML, no build step): a market/intent/cart overview, a live run view, a demo driver that exercises the public buyer/seller/runner wire, a reputation panel, and one adjustment control. The adjustment is `POST /ops/api/runs/:runId/settle` with `{mode, ambiguous?, requestedPlatformLossKobo?, reason?}` — RunDO validates it, builds a `SettlementInput` (the reason is echoed context, never a side channel), calls the settlement function once, broadcasts `settlement.released` + `run.retired`, archives both, and deletes DO storage. Ops can pick the mode and dispute evidence shape; every kobo still comes out of `settle()` (ADR-0007).

## Consequences

- The MVP's full money path — capture to ledger — is now exercised end-to-end in dev against a local Postgres (infra/README).
- Integration tests: the edge suite drives the public HTTP surface (e2e) and the archive suite has an opt-in real-database test (`ARCHIVE_TEST_DATABASE_URL`).
- When participant auth ships, the optional identity fields narrow to server-asserted ones; the archive schema does not change.
