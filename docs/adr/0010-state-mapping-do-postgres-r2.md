# Live state in Durable Objects, records in Postgres, media in R2

Every domain concept has exactly one home. Live, ephemeral state lives in Durable Objects — MarketDO per market zone (intents, matching, open/close gate, trip auction), ProductDO per product (negotiation, accept-once, retirement), CartDO per cart (the shared lap-timer deadline), RunDO per trip (handoffs, location, settlement trigger). Durable records (stores, shop items, KYC records, archived products, settlement records, disputes) live in Postgres. Handoff media lives in R2 behind a capture endpoint that returns a signed reference. Timers are DO alarms, each object owning its own clock. The settlement function, matching, floor rate, and timer rules are pure TypeScript in a shared domain package with no platform imports.

The reason is the accept-once guarantee: a Durable Object serializes its own mutations, so ephemeral things get atomicity for free — but DO storage is unqueryable, so anything the business must ever report on must leave the object at retirement (via a queue consumer into Postgres).

## Consequences

- Monorepo: `packages/domain` (pure logic), `packages/proto` (zod message schemas), `apps/edge`, `apps/archive`, `apps/mobile`.
- Nothing straddles two homes; if a concept seems to, the domain model is wrong, not the mapping.
