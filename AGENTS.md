# AGENTS.md — Market Runs

An on-demand errand marketplace for Nigeria: buyers post intents, sellers respond with ephemeral offers, one runner aggregates a buyer's cart into a single trip with QR-challenge handoffs, and a settlement function releases payment at trip close.

## Read these first — they are the source of truth

- `GLOSSARY.md` — the domain language. Use these exact terms in code (types, tables, events). If a concept isn't in the glossary, it isn't in the system.
- `docs/adr/0001`–`0026` — every significant decision and *why*. Do not "fix" anything an ADR records as deliberate without flagging it to the human.
- `docs/runbooks/` — operational runbooks (e.g. `first-live-test.md` for real-human test sessions). Keep them accurate against the code; they are followable-cold documents.

If you change anything these documents describe, update them in the same change.

## Stack (settled — ADR-0010, 0011, 0012)

- Cloudflare Workers + Durable Objects (WebSocket hibernation, DO alarms for all timers), Queues, R2, KV, Cron Triggers
- Postgres on Neon via Hyperdrive, Drizzle migrations — the system of record, **ledger included; never D1 for money**
- TypeScript everywhere; zod schemas shared between edge and mobile in `packages/proto`
- Expo React Native single client, three roles (buyer/seller/runner), camera-only capture (never request media-library permissions)
- Payments and KYC vendors behind internal abstractions (ADR-0009); vendor names never appear in the domain model
- Routing: OSRM self-hosted, called at checkout, result cached in the RunDO (local dev points `OSRM_BASE_URL` at the free public demo server — see infra/osrm/README.md)
- Tests: Vitest + `@cloudflare/vitest-pool-workers`

## Repo layout

```
packages/domain/   # settlement function, matching, floor rate, timer rules, reputation, ops-health gate — PURE, no platform imports
packages/proto/    # zod schemas for every WS/HTTP message, incl. archive events and admin oversight schemas
apps/edge/         # Hono app (app/ routes + auth middleware), ops oversight dashboard (ops-console/: html, archive-proxy, identity-admin device-reset queue, markets-admin + vocabulary moderation; config/markets.ts), the five DOs (do/), each folder a barrel
apps/archive/      # Queue consumer: retirement snapshots → Postgres/R2 + reputation read path + /admin/* oversight read endpoints
apps/identity/     # passwordless auth worker (port 8789): face enroll/verify, HMAC sessions, device keys + ops-approved reset — FaceVerifier/PasskeyVerifier seams, encrypted embeddings at rest; Smile ID vendor mode (vendor-held biometric, async 202 → poll/callback) behind FACE_VERIFIER=smileid (ADR-0022)
apps/payments/     # payment worker (port 8790): consumes payment.dispatch-requested, executes settlement legs via PaymentDispatcher with per-leg idempotency + DLQ, /ops Payments tab (ADR-0023); FlutterwaveDispatcher in src/flutterwave/ behind PAYMENT_DISPATCHER (ADR-0024); buyer collection — /payments/charges/confirm server-side verify, payment_holds, the refund rail (payment.refund-requested; card via provider, non-card → refund-manual), seller payout accounts (resolve-then-save, DB-first recipients) (ADR-0025)
apps/mobile/       # Expo app — src/api (wire client barrel + cart-state store for edge-issued ids), src/features/{buyer,seller,runner,run} (role hooks + the shared run/trip surface, barrels), src/ui (theme/styles/layout/controls/format barrel)
infra/             # wrangler configs, Drizzle migrations, dev-all.sh one-command demo stack + seed-demo.mjs (dev-servers.sh underneath), OSRM deploy
```

Auth flows through one seam: `apps/edge/src/app/middleware/participant.ts` resolves
the caller; routes guard with role middleware. Real auth has landed **partially**
(ADR-0022): `resolveParticipant` now also accepts `Authorization: Bearer` sessions
issued by `apps/identity` (source `"session"`, verified locally — no round trip),
while header mode is retained for dev. ADR-0015's promise held: only
`resolveParticipant` changed.

## State mapping (ADR-0010)

Every concept has exactly one home. Live/ephemeral state → Durable Objects: **MarketDO** (per market zone: intents, store registry + item vocabulary, member list, matching, open/close gate, trip auction), **ProductDO** (per product: negotiation, accept-once, retirement), **CartDO** (per buyer per market — `cart:<market>:<buyerId>` — the shared deadline), **RunDO** (per trip: handoffs, location, settlement trigger), **ParticipantDO** (per participant — `participant:<id>` — onboarding, KYC status, joined markets; dev-stage home, ADR-0016). Durable records → Postgres — including the `live_runs` index that makes in-flight runs enumerable for oversight, fed by `run.started` at checkout (DOs are never listed; ADR-0017). Media → R2 behind a capture endpoint returning a signed reference. DOs do not replicate — each object is a single-threaded singleton, so horizontal scale is the number of objects plus the stateless edge; per-object state discipline (no unbounded blobs) is what keeps that true.

Cart/run ids are **edge-authoritative** (ADR-0018): clients never derive them — they learn the cart id from the accept response (`cart.updated.cart.id`) or the header-keyed `GET /markets/:market/cart`, and checkout echoes the edge-issued id. `GET /markets/:market/runs/active` is the client-safe discovery over the `live_runs` index for runners (their assigned runs) and sellers (`?storeId=` — runs containing their store, from the `store_ids` recorded at checkout), degrading to empty + warning when the archive is down. The ops console's market overview takes a buyer picker (`?buyerId=` on `/ops/api/overview`) for the same reason. Live events are **topic-filtered** (`intents`, `intent:<id>`, `product:<id>`, `cart:<id>`, `run:<id>`, `market` — delivery by topic intersection, fail-open for topic-less sockets and unclassified event types), and `GET /markets/:market/discovery` is the scoped discovery read: `?shopItems=` for sellers (matching intents only, products inline), `?buyerId=`/identity header for buyers, both intersect, scope-less returns empty (ADR-0021).

## Timers (v1 defaults — tunable per market; the *structure* is doctrine)

| Clock | Value | Owner |
|---|---|---|
| Intent TTL | 30 min | MarketDO |
| Product TTL | dies with its intent, max 30 min from creation | ProductDO |
| Cart deadline | 30 min from first acceptance, +10 min per additional acceptance, hard ceiling 60 min; whole cart expires atomically | CartDO |
| Trip auction window | 3 min, then best bid wins, else internal floor | MarketDO |
| Market-close gate | checkout requires `close − now > est. trip duration + buffer` | MarketDO |
| Handoff auto-confirm | 3 min; buyer silence = consent, but only with photo evidence attached — a photoless handoff stays pending and re-arms | RunDO |
| Dispute window | 30 min after final delivery, then settlement auto-releases | RunDO |

## Doctrine (violations are bugs)

- Products are **retired, never resurrected**; accept-once is guaranteed by the object being single-threaded
- All money movement is expressed **only through the settlement function** — no ad-hoc transfers or side-channel refunds (ADR-0007); dispatch is execution via the payments queue, carrying the settlement's legs verbatim — the settlement function remains the only money decision (ADR-0023). Checkout may be **gated on a confirmed payment hold** (`PAYMENTS_REQUIRED`, dev default off — CartDO cross-checks amount and refuses shortfall), and buyer refunds ride the **refund rail** (`payment.refund-requested` → provider refund for card charges, honest terminal `refund-manual` for non-card) (ADR-0025)
- **Aborts never refund fully**: runner and platform settle partially (ADR-0008)
- Retirement = snapshot to Postgres/R2 via the archive queue, then delete DO storage
- **Handoffs confirm only with photo evidence** (ADR-0020): the QR scan alone records `scannedAt`; attaching the photo *is* the confirm, and buyer silence = consent fires only with a photo attached — a run can never reach settlement photoless (ops settle is the human escape hatch). Evidence (photo refs + scan/confirm timestamps) rides the run wire; dispute evidence merges server-side — the client never enumerates refs (ADR-0019)
- Location stream is throttled fire-and-forget; confirmations are must-arrive with idempotency keys

## MVP scope (ADR-0013)

One market (TBD — the founder names it; update ADR-0013), delivery by internal runners at floor rate only. **Not in MVP**: trip auction, gig runner onboarding, steganographic media signing, USSD flows, user-entered ratings. Build everything auction-shaped so v2 is additive.

Dev-stage test rig: `pnpm dev:all` brings up the whole stack with a demo seed, and `-- --tunnel` plus `npx expo start --tunnel` is the two-tunnel friends demo (infra/README.md) — the pre-launch way to put real phones on real markets.

## Open inputs (ask the human, do not guess)

- Launch market name
- Credentials: Neon connection string, KYC vendor keys (never commit; use wrangler secrets). PSP keys: Flutterwave test key lives in gitignored `infra/.dev.vars` (never committed), production keys via wrangler secrets; `PAYMENT_DISPATCHER=flutterwave` switches it on (ADR-0024). Smile ID sandbox keys (`SMILEID_PARTNER_ID` / `SMILEID_API_KEY` / `SMILEID_CALLBACK_URL` / `SMILEID_PRIVACY_NOTICE_URL`) — owner to supply; `FACE_VERIFIER=smileid` without them throws at startup (ADR-0022, amended)

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **market-runs** (1644 symbols, 4224 relationships, 120 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/market-runs/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/market-runs/context` | Codebase overview, check index freshness |
| `gitnexus://repo/market-runs/clusters` | All functional areas |
| `gitnexus://repo/market-runs/processes` | All execution flows |
| `gitnexus://repo/market-runs/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
