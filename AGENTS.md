# AGENTS.md — Market Runs

An on-demand errand marketplace for Nigeria: buyers post intents, sellers respond with ephemeral offers, one runner aggregates a buyer's cart into a single trip with QR-challenge handoffs, and a settlement function releases payment at trip close.

## Read these first — they are the source of truth

- `GLOSSARY.md` — the domain language. Use these exact terms in code (types, tables, events). If a concept isn't in the glossary, it isn't in the system.
- `docs/adr/0001`–`0030` — every significant decision and *why*. Do not "fix" anything an ADR records as deliberate without flagging it to the human.
- `docs/runbooks/` — operational runbooks (e.g. `first-live-test.md` for real-human test sessions). Keep them accurate against the code; they are followable-cold documents.

If you change anything these documents describe, update them in the same change.

## Stack (settled — ADR-0010, 0011, 0012)

- Cloudflare Workers + Durable Objects (WebSocket hibernation, DO alarms for all timers), Queues, R2, Cron Triggers
- Postgres on Neon via Hyperdrive, Drizzle migrations — the system of record, **ledger included; never D1 for money**
- TypeScript everywhere; zod schemas shared between edge and mobile in `packages/proto`
- Expo React Native single client, three roles (buyer/seller/runner), camera-only capture (never request media-library permissions)
- Payments and KYC vendors behind internal abstractions (ADR-0009); vendor names never appear in the domain model
- Routing: OSRM self-hosted, called at checkout, result cached in the RunDO (local dev points `OSRM_BASE_URL` at the free public demo server — see infra/osrm/README.md)
- Tests: Vitest + `@cloudflare/vitest-pool-workers`

## Repo layout

```
packages/domain/   # settlement function, canonical settlement→payment projection, matching, floor rate, timer rules, reputation, ops-health gate — PURE, no platform imports
packages/proto/    # zod schemas for every WS/HTTP message, incl. archive events and admin oversight schemas
apps/edge/         # Hono app (app/ routes + auth middleware), operator JSON API + Better Auth (ops-console/: archive-proxy, identity-admin device-reset queue, markets-admin + vocabulary moderation; config/markets.ts), the five DOs (do/), each folder a barrel; no embedded HTML
apps/archive/      # Queue consumer: retirement snapshots → Postgres/R2, then commit-before-enqueue settlement payment emission + retries/DLQ (ADR-0029); reputation read path + /admin/* oversight read endpoints
apps/identity/     # passwordless auth worker (port 8789): proof-bound hybrid face enrollment, local 1:1 login/recovery, HMAC sessions, device keys, encrypted embeddings + Smile ID providerRef (ADR-0022, 0027)
apps/biometrics/   # private Dockerized Node ONNX service (port 8791): ArcFace embeddings + MiniFASNet liveness; identity-only bearer access, no mobile route or capture persistence (ADR-0027)
apps/payments/     # payment worker (port 8790): consumes payment.dispatch-requested, authorizes against durable settlements, executes legs via PaymentDispatcher with per-leg idempotency + DLQ, settlement re-drive + /ops Payments tab (ADR-0023, 0029); FlutterwaveDispatcher in src/flutterwave/ behind PAYMENT_DISPATCHER (ADR-0024); buyer collection — /payments/charges/confirm server-side verify, payment_holds, the refund rail (payment.refund-requested; card via provider, non-card → refund-manual), seller payout accounts (resolve-then-save, DB-first recipients) (ADR-0025)
apps/mobile/       # Expo app — src/api (wire client barrel + cart-state store for edge-issued ids), src/features/{buyer,seller,runner,run} (role hooks + the shared run/trip surface, barrels), src/ui (theme/styles/layout/controls/format barrel)
apps/ops/          # dedicated React + Vite operator app at ops.marketruns.org; Better Auth password/admin magic links via same-origin /ops proxy and staging edge service binding
apps/site/         # Next.js brand site + early-access registration (Drizzle/Postgres, Resend Audience + React Email confirmation); Better Auth admin portal with visitor registrations, threaded rich-text inbox replies with attachments, and admin-only inbound attachment downloads; Resend inbound webhook (POST /api/webhooks/resend, svix-verified) receives the Smile ID lead-pipeline email
infra/             # wrangler configs, Drizzle migrations, dev-all.sh one-command demo stack + seed-demo.mjs (dev-servers.sh underneath), OSRM deploy
```

Auth flows through one seam: `apps/edge/src/app/middleware/participant.ts` resolves
the caller; routes guard with role middleware. Real auth has landed **partially**
(ADR-0022): `resolveParticipant` now also accepts `Authorization: Bearer` sessions
issued by `apps/identity` (source `"session"`, verified locally — no round trip),
while header mode is retained for dev. ADR-0015's promise held: only
`resolveParticipant` changed.

## State mapping (ADR-0010)

Every concept has exactly one home. Live/ephemeral state → Durable Objects: **MarketDO** (per market zone: intents, store registry + item vocabulary, member list, matching, open/close gate, trip auction), **ProductDO** (per product: negotiation, accept-once, retirement), **CartDO** (per buyer per market — `cart:<market>:<buyerId>` — the shared deadline), **RunDO** (per trip: handoffs, location, settlement trigger), **ParticipantDO** (per participant — `participant:<id>` — onboarding, KYC status, joined markets; dev-stage home, ADR-0016). Durable records → Postgres — including the `live_runs` index that makes in-flight runs enumerable for oversight, `carts_archive` for buyer history, accepted-product sales history, and archive queue receipts (DOs are never listed; ADR-0017). `GET /history` is the session-scoped participant history read. Media → R2 behind a capture endpoint returning a signed reference; retired product and expired intent media become private finite retained records (`retained_media`: seven days for unaccepted/expired subjects, 90 days from run close for sold products, with admin holds), while ordinary product/cart snapshots omit media references and handoff/dispute evidence follows its separate retention rules (ADR-0031). DOs do not replicate — each object is a single-threaded singleton, so horizontal scale is the number of objects plus the stateless edge; per-object state discipline (no unbounded blobs) is what keeps that true.

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
- All money movement is expressed **only through the settlement function** — no ad-hoc transfers or side-channel refunds (ADR-0007); dispatch is execution via the payments queue, carrying the settlement's legs verbatim — the settlement function remains the only money decision (ADR-0023). Settlement archive persistence **commits before canonical payment enqueue and archive acknowledgement** (ADR-0029); admin re-drive uses the durable record, never client-supplied legs. Queue execution and successful Ops replay release holds only when every dispatch leg is sent, queued, or completed; pending or failed siblings keep them blocked. Checkout may be **gated on a confirmed payment hold** (`PAYMENTS_REQUIRED`, dev default off — CartDO cross-checks amount and refuses shortfall), and buyer refunds ride the **refund rail** (`payment.refund-requested` → provider refund for card charges, honest terminal `refund-manual` for non-card) (ADR-0025). Ambiguous refund attempts **reconcile exact provider history before any retry**; conflicting history blocks automation as `refund-review`. Admin resolution is **write-once evidence plus a narrow state transition**, never arbitrary money editing (ADR-0030)
- **Aborts never refund fully**: runner and platform settle partially (ADR-0008). Settlement persistence resolves the run's dispute in the same transaction, preserving its evidence and recording settlement id, resolution time, ambiguity, and absorbed loss (ADR-0026)
- Retirement = snapshot to Postgres/R2 via the archive queue, then delete DO storage
- **Handoffs confirm only with photo evidence** (ADR-0020): the QR scan alone records `scannedAt`; attaching the photo *is* the confirm, and buyer silence = consent fires only with a photo attached — a run can never reach settlement photoless (ops settle is the human escape hatch). Evidence (photo refs + scan/confirm timestamps) rides the run wire; dispute evidence merges server-side — the client never enumerates refs (ADR-0019)
- Location stream is throttled fire-and-forget; confirmations are must-arrive with idempotency keys

## MVP scope (ADR-0013)

One market (TBD — the founder names it; update ADR-0013), delivery by internal runners at floor rate only. **Not in MVP**: trip auction, gig runner onboarding, steganographic media signing, USSD flows, user-entered ratings. Build everything auction-shaped so v2 is additive.

Dev-stage test rig: `pnpm dev:all` brings up the whole stack with a demo seed, and `-- --tunnel` plus `npx expo start --tunnel` is the two-tunnel friends demo (infra/README.md) — the pre-launch way to put real phones on real markets.

## Open inputs (ask the human, do not guess)

- Launch market name
- Staging provisioning uses `bash infra/staging-setup.sh`; strict go/no-go uses `bash infra/staging-check.sh`. Deployed archive and notification reads require `ARCHIVE_INTERNAL_TOKEN` and `NOTIFICATION_INTERNAL_TOKEN`; the document-HMAC development fallback exists only with `ALLOW_HEADER_AUTH=true`.
- Credentials/resources: Neon connection string, KYC vendor keys (never commit; use wrangler secrets). PSP keys: Flutterwave test key lives in gitignored `infra/.dev.vars` (never committed), production keys via wrangler secrets; `PAYMENT_DISPATCHER=flutterwave` switches it on (ADR-0024). Hybrid identity needs Smile ID keys (`SMILEID_PARTNER_ID` / `SMILEID_API_KEY` / `SMILEID_CALLBACK_URL` / `SMILEID_PRIVACY_NOTICE_URL`), private biometrics URL/token and face/liveness models, and the private `IDENTITY_CAPTURES` R2 bucket; `FACE_VERIFIER=hybrid` without vendor/service configuration fails at startup (ADR-0028). Account-deletion propagation for the retained enrollment selfie remains an explicit implementation requirement.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **marketruns** (7734 symbols, 22060 relationships, 656 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/marketruns/context` | Codebase overview, check index freshness |
| `gitnexus://repo/marketruns/clusters` | All functional areas |
| `gitnexus://repo/marketruns/processes` | All execution flows |
| `gitnexus://repo/marketruns/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
