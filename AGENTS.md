# AGENTS.md — Market Runs

An on-demand errand marketplace for Nigeria: buyers post intents, sellers respond with ephemeral offers, one runner aggregates a buyer's cart into a single trip with QR-challenge handoffs, and a settlement function releases payment at trip close.

## Read these first — they are the source of truth

- `GLOSSARY.md` — the domain language. Use these exact terms in code (types, tables, events). If a concept isn't in the glossary, it isn't in the system.
- `docs/adr/0001`–`0013` — every significant decision and *why*. Do not "fix" anything an ADR records as deliberate without flagging it to the human.

If you change anything these documents describe, update them in the same change.

## Stack (settled — ADR-0010, 0011, 0012)

- Cloudflare Workers + Durable Objects (WebSocket hibernation, DO alarms for all timers), Queues, R2, KV, Cron Triggers
- Postgres on Neon via Hyperdrive, Drizzle migrations — the system of record, **ledger included; never D1 for money**
- TypeScript everywhere; zod schemas shared between edge and mobile in `packages/proto`
- Expo React Native single client, three roles (buyer/seller/runner), camera-only capture (never request media-library permissions)
- Payments and KYC vendors behind internal abstractions (ADR-0009); vendor names never appear in the domain model
- Routing: OSRM self-hosted, called at checkout, result cached in the RunDO
- Tests: Vitest + `@cloudflare/vitest-pool-workers`

## Repo layout

```
packages/domain/   # settlement function, matching, floor rate, timer rules — PURE, no platform imports
packages/proto/    # zod schemas for every WS/HTTP message
apps/edge/         # Worker entry, HTTP API, WS gateways, the four DO classes
apps/archive/      # Queue consumer: retirement snapshots → Postgres/R2
apps/mobile/       # Expo app
infra/             # wrangler configs, Drizzle migrations, OSRM deploy
```

## State mapping (ADR-0010)

Every concept has exactly one home. Live/ephemeral state → Durable Objects: **MarketDO** (per market zone: intents, matching, open/close gate, trip auction), **ProductDO** (per product: negotiation, accept-once, retirement), **CartDO** (per cart: the shared deadline), **RunDO** (per trip: handoffs, location, settlement trigger). Durable records → Postgres. Media → R2 behind a capture endpoint returning a signed reference.

## Timers (v1 defaults — tunable per market; the *structure* is doctrine)

| Clock | Value | Owner |
|---|---|---|
| Intent TTL | 30 min | MarketDO |
| Product TTL | dies with its intent, max 30 min from creation | ProductDO |
| Cart deadline | 30 min from first acceptance, +10 min per additional acceptance, hard ceiling 60 min; whole cart expires atomically | CartDO |
| Trip auction window | 3 min, then best bid wins, else internal floor | MarketDO |
| Market-close gate | checkout requires `close − now > est. trip duration + buffer` | MarketDO |
| Handoff auto-confirm | 3 min; buyer silence = consent | RunDO |
| Dispute window | 30 min after final delivery, then settlement auto-releases | RunDO |

## Doctrine (violations are bugs)

- Products are **retired, never resurrected**; accept-once is guaranteed by the object being single-threaded
- All money movement is expressed **only through the settlement function** — no ad-hoc transfers or side-channel refunds (ADR-0007)
- **Aborts never refund fully**: runner and platform settle partially (ADR-0008)
- Retirement = snapshot to Postgres/R2 via the archive queue, then delete DO storage
- Location stream is throttled fire-and-forget; confirmations are must-arrive with idempotency keys

## MVP scope (ADR-0013)

One market (TBD — the founder names it; update ADR-0013), delivery by internal runners at floor rate only. **Not in MVP**: trip auction, gig runner onboarding, steganographic media signing, USSD flows, user-entered ratings. Build everything auction-shaped so v2 is additive.

## Open inputs (ask the human, do not guess)

- Launch market name
- Credentials: Neon connection string, PSP keys, KYC vendor keys (never commit; use wrangler secrets)
