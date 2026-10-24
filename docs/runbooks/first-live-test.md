# Runbook — First Live Test (session day)

The first real-human test: 2–4 untrained friends on their own phones (Expo Go,
over tunnels), the owner playing **runner + ops** from the laptop, with the ops
dashboard as the session console. Money-in runs through Flutterwave **test
mode**. Face verification runs through the Smile ID **sandbox** when sandbox
keys are available; otherwise the stub verifier (the default) is the sanctioned
fallback — record that identity ran stubbed. Nothing is real money; no real
identity is verified.

This runbook is written to be followable cold by someone who did not build the
system. Read §0–§2 the morning of the event; keep §5 (incidents) and §6
(STOP conditions) open during the session; do §7 within an hour of the last
tester leaving.

---

## 0. Go / no-go pre-flight checklist

Run every item. Any red box = do not start; fix first or drop the affected
scenarios (see §6 incident scripts for sanctioned fallbacks).

| # | Check | Command / where | Pass looks like |
|---|-------|-----------------|-----------------|
| 1 | Stack boots clean | `npx pnpm@9.15.4 dev:all -- --tunnel` | Postgres ready, migrations applied, edge :8787 / archive :8788 / identity :8789 / payments :8790 all healthy, demo seed no-ops, summary box prints tunnel URL + `EXPO_PUBLIC_EDGE_URL=…` line + guarded `/ops?token=…` link |
| 2 | Demo driver passes end-to-end | Ops console → "Dev demo driver" panel (collapsed at the bottom) | Buyer → seller → runner wire flow completes with no error feed entries |
| 3 | Reconcile exits 0 modulo baseline | `node infra/reconcile.mjs` (full stack up so queued dispatches land first) | Exit 0. **If the two known 2026-10-15 baseline settlements are still present**, the only accepted exceptions are their 6 payout legs with no dispatch rows (created before the payments worker existed) — document them once in the session log and never re-litigate them. A fresh/reset dev DB will not have them. **Pre-alias e2e baseline (2026-10-21):** dispatch WARNs whose `payment_dispatches.provider_reference IS NULL` are pre-fix e2e artifacts (12 stub terminal legs + 12 reference-cap/recipient failures) retained as evidence; they are explained and must not be replayed as part of the session. Any WARN row with a non-null `provider_reference`, any *other* FAIL, or any unexplained WARN is no-go. |
| 4 | Buyer collection key | `apps/mobile/.env` → `EXPO_PUBLIC_FLW_PUBLIC_KEY=FLWPUBK_TEST-…` | Set; unset silently degrades checkout to unpaid dev mode |
| 5 | Payout dispatcher | `infra/.dev.vars` → `PAYMENT_DISPATCHER=flutterwave`, `FLUTTERWAVE_SECRET_KEY=FLWSECK_TEST-…`, and `FLUTTERWAVE_TEST_MODE=true` | Payments worker starts without throwing (a missing key throws at startup). `FLUTTERWAVE_TEST_MODE` (ADR-0026) appends the provider's mock-success suffix so mock transfers complete in **~1 min instead of ~10**; reconcile strips the same suffix. The provider reference is the short deterministic alias (`mr_` + 48 hex, ADR-0024 amendment), not the 66+ character local idempotency key, so it fits Flutterwave's 64-character cap. Real test-mode payouts are expected to dispatch; confirm the Payments tab shows `queued`/`sent`/`completed`, not `failed`. |
| 6 | Webhook hash | `infra/.dev.vars` → `FLUTTERWAVE_WEBHOOK_SECRET_HASH=<random 64-hex>`, same value pasted in Flutterwave dashboard → Settings → Webhooks → Secret hash | Unset ⇒ the webhook route 503s; wrong ⇒ 401. (Optional in dev — see §1.3 for the fallback.) |
| 7 | Face verifier | `infra/.dev.vars` → `FACE_VERIFIER=smileid`, `SMILEID_PARTNER_ID`, `SMILEID_API_KEY`, `SMILEID_ENV=sandbox` (default) | Identity worker starts without throwing (`FACE_VERIFIER=smileid` without keys throws at startup). **No Smile ID credentials yet?** Leave `FACE_VERIFIER` unset (stub default), restart, and record "identity stubbed" in the session log — the trust/money scenarios stay runnable; live KYC is not exercised. |
| 8 | Paid-flow gate | `infra/.dev.vars` → `PAYMENTS_REQUIRED=true` | Edge requires a confirmed payment hold at checkout. **Only set this when testing the paid flow** — with it unset, checkout is the unpaid dev posture. |
| 9 | Tunnel decision made | See §1.2 | Quick tunnel URL is printed; **named tunnel recommended** |
| 10 | Flutterwave dashboard webhook | Dashboard → Settings → Webhooks | Points at `https://<edge-tunnel>/webhooks/transfers` — **the main edge tunnel** (the edge proxies `/webhooks/*` to the payments worker as a dumb pipe; hash verification stays at the worker). No second tunnel needed. See §1.3. |

Notes on the posture:

- `infra/.dev.vars` sits next to the wrangler configs and is read by **all**
  dev workers; keys a worker does not use are ignored. It is gitignored at any
  depth — never commit it.
- Wrangler does not hot-reload `.dev.vars` edits reliably mid-session: after
  changing any of items 4–8, restart the stack (Ctrl-C, then `dev:all` again).
- Run reconcile (item 3) with the full stack up. A session with unpaid
  checkout or a stopped payments worker produces settlements with missing
  dispatch rows and `dispatch-completeness` FAILs until the queue drains.

---

## 1. Setup, morning of the event

### 1.1 Boot the stack

```bash
npx pnpm@9.15.4 dev:all -- --tunnel
```

Leave this running all session. Ctrl-C stops everything it started (Postgres
data persists in the container).

### 1.2 Tunnel decision — prefer a named tunnel

`--tunnel` starts a **quick** tunnel (`*.trycloudflare.com`). Quick tunnels
**change URL every boot**, which breaks anything registered against the URL —
the Flutterwave webhook, `SMILEID_CALLBACK_URL`, and every friend's
`EXPO_PUBLIC_EDGE_URL`.

Recommended: use a **named tunnel** with a stable hostname, and route:

- `<tunnel-host>` → `http://localhost:8787` (edge — app API/WS + ops console)

**One tunnel suffices.** The edge proxies `/webhooks/*` to the payments worker
(Flutterwave transfer/charge webhooks) and `/callbacks/*` to the identity
worker (the Smile ID callback is `POST /callbacks/smileid`) as dumb pipes —
signature/hash verification stays at the owning worker (ADR-0026). Neither the
payments worker on :8790 nor the identity worker on :8789 needs its own
exposure. If you set `SMILEID_CALLBACK_URL`, point it at
`https://<edge-tunnel>/callbacks/smileid`.

If you stay on quick tunnels, you must re-register the webhook (§1.3) and
re-distribute the ops link every time you restart the backend tunnel.

### 1.3 Flutterwave webhook

In the Flutterwave dashboard → Settings → Webhooks:

- URL: `https://<edge-tunnel>/webhooks/transfers` — the **edge tunnel**. The
  edge forwards the request (path, query, body, and the `verif-hash` header)
  verbatim to the payments worker on :8790, which verifies the hash; no
  payments-worker tunnel is needed.
- Secret hash: the exact value of `FLUTTERWAVE_WEBHOOK_SECRET_HASH` from
  `infra/.dev.vars`.

If the webhook is unreachable, transfers still converge: they stay
`sent`/`queued` until the webhook lands or until you run the polling fallback
(`POST /dispatches/sync` polls rows stale > 15 min by default). The reconcile
script flags rows pending past `--pending-minutes` (default 30) as WARN —
expect a few of these in a short session and explain them in the session log
rather than treating webhook lag as a failure. With `FLUTTERWAVE_TEST_MODE=true`
(§0 item 5) mock transfers land in ~1 min, so pending WARNs should be rare.

### 1.4 Open the session console

Open the guarded ops link printed in the boot summary box:
`https://<tunnel>/ops?token=<OPS_TOKEN>`. With `--tunnel`, an `OPS_TOKEN` is
mandatory — a random one is generated if unset. Never share this link with
testers.

Console orientation (one embedded page, no build step):

- **Header** — market selector, gate-pass pill, **Markets** button (zone admin
  dialog: market config + vocabulary moderation).
- **Gate-metrics strip** — five market health numbers.
- **Left column** — market overview (buyer picker) + runs list.
- **Middle column** — run detail (per-handoff photo/timestamp evidence and,
  while a run is disputed, the dispute block: reason, raiser, merged evidence
  refs) + **ops settle** control.
- **Right column** — Oversight tabs: **Disputes · Settlements · Ledger ·
  Reputation · Payments · Resets** (the device-reset approval queue).
- **Bottom strip** — capped live event feed; collapsed dev demo driver.

### 1.5 Friends' phones

Each friend: install **Expo Go**, join nothing, sign nothing. On your Mac run
`npx expo start --tunnel` in `apps/mobile` (needs `@expo/ngrok`), and have each
friend scan the QR code. `apps/mobile/.env` must carry
`EXPO_PUBLIC_EDGE_URL=https://<tunnel>` (the backend tunnel) and
`EXPO_PUBLIC_FLW_PUBLIC_KEY=FLWPUBK_TEST-…`. **One phone = one participant** —
identity is per device (see casting, §3).

Phones on the same Wi-Fi as the Mac can skip the tunnels: set
`EXPO_PUBLIC_EDGE_URL` to the Mac's LAN IP instead (see
`apps/mobile/.env.example`).

---

## 2. Tester briefing script (read aloud, verbatim where marked)

Say this to every tester before they touch the phone:

> **Consent wording — read verbatim:**
>
> "This test captures your face photo and ID number through a test verifier —
> no real verification happens, no real money moves, data is stored only on
> this development machine and deleted after the test. Say yes to proceed."

Then cover, in your own words but without skipping any:

- **Never type a real BVN or NIN.** When a form asks for an ID number, type
  **any 11 digits** (e.g. `12345678901`). The sandbox/stub verifier does not
  check them against anything real.
- **Money is fake.** Test keys, test bank accounts, test cards. Nothing can
  reach a real account.
- **Face verdicts are simulated.** The Smile ID sandbox returns canned
  results (and in stub mode the verifier is local); a "pass" does not mean your
  face was matched against a real record.
- One phone = one person. If the app asks you to sign in as someone else, hand
  the phone back instead.
- You are not being tested — the app is. Every time you get confused, that is
  a finding, not a failure. Say what you were expecting out loud.

Get an explicit "yes" to the consent wording before onboarding each tester.

---

## 3. Casting & test data

### Roles

| Who | Plays | Device |
|-----|-------|--------|
| Owner | **Runner** + **ops console** | Laptop (dashboard) + own phone for the runner role |
| Friend 1 | **Seller** (at least one) | Own phone |
| Friends 2–3(–4) | **Buyers** (at least two) | Own phones |

### Seller payout onboarding (test bank accounts)

When the seller onboards a payout account, use Flutterwave's documented test
accounts — the resolve step returns the canned name the bank "returns":

- Bank: **044 — Access Bank**
- Account numbers: **0690000031**, **0690000032**, **0690000033**

(These are also the fallback recipients for the demo seed's seller stores —
`Amina's Fresh Store`, `Mama Ngozi Provisions`, `Emeka Phones & Accessories` —
plus `runner:internal` and `platform`. Seller settlement legs carry the store
display name at this stage, not the participant id. Real test-mode payouts use
the short provider alias from ADR-0024's amendment; see `infra/README.md` for
the alias/mapping details.)

### Buyer test cards

Use Flutterwave test cards in the checkout webview. Rules of the sandbox
modal:

- **Any OTP passes** the modal.
- Entering OTP **`6648`** simulates **insufficient funds** — use it in the
  resilience scenario (S5) and anywhere you want a declined charge.

---

## 4. Scenario scripts

Each script gives: what the tester taps, what they should see, and which
dashboard panels you watch. Run S1–S2 with everyone first; S3–S6 as time
allows. Note every hesitation and every wrong tap — that is the data.

### S1 — Onboarding (face enroll + seller payout account)

| Step | Actor | Action | Expected screen | Watch on dashboard |
|------|-------|--------|-----------------|--------------------|
| 1 | Each friend | Open the app in Expo Go | Role picker / sign-in | — |
| 2 | Each friend | Sign up, enter any 11-digit ID | Face capture prompt; consent shown | Event feed: participant registered |
| 3 | Each friend | Take the selfie | Async job: "verifying…" (submit → 202 → poll); then enrolled | — |
| 4 | Seller | Add payout account: bank 044, account 0690000031 | Account name resolve shows the bank-returned name; confirm saves | — |
| 5 | Seller | Return to seller home | Masked account shown with a change path | — |

Sandbox face verdicts are simulated — expect enroll to pass regardless of the
actual photo. If Smile ID is down or unconfigured, the stub verifier does the
same synchronously (§6, incident I2); note "identity stubbed" in the log.

### S2 — Happy-path paid run with photo handshakes

| Step | Actor | Action | Expected screen | Watch on dashboard |
|------|-------|--------|-----------------|--------------------|
| 1 | Buyer | Post an intent from the market vocabulary | Intent live with 30-min TTL | Market overview: intent appears |
| 2 | Seller | See the matching intent; create an offer (product) | Offer sent to buyer | Market overview |
| 3 | Buyer | Accept the offer | Item lands in cart; cart deadline starts (30 min from first acceptance) | Market overview (buyer picker): cart |
| 4 | Buyer | Checkout → pay in the Flutterwave webview (test card, any OTP) | Charge collected, then "payment confirmed"; run created | **Payments tab**: charge confirmed, hold `held`; runs list: new live run |
| 5 | Owner (runner) | See the run; start the trip | Run detail with stops | Run detail |
| 6 | Owner + seller | Pickup handoff: seller shows QR, runner scans, **takes handoff photo** | Pickup confirmed | Run detail: `scannedAt` then photo confirm |
| 7 | Owner + buyer | Delivery handoff: same QR + photo dance | Delivered; dispute window opens (30 min) | Run detail; event feed |
| 8 | Owner | Let the dispute window lapse (or ops-settle early to keep the session moving) | Settlement releases | **Settlements tab**: new settlement; **Ledger tab**: balanced entries; **Payments tab**: payout legs dispatch to the seller/runner/platform test accounts |

Remind the buyer before step 6: a handoff **never confirms without a photo** —
the QR scan alone only records `scannedAt`. This is doctrine, not a bug.

### S3 — Dispute at delivery → ops settle from the dashboard

| Step | Actor | Action | Expected screen | Watch on dashboard |
|------|-------|--------|-----------------|--------------------|
| 1–6 | As S2 steps 1–6 | Happy path to pickup | — | — |
| 7 | Buyer | At delivery, **file a dispute** instead of confirming | Dispute recorded on the run | Run detail shows dispute; **Disputes tab** — known limitation L2: the row materializes at run retirement (doctrine, ADR-0026) |
| 8 | Owner (ops) | In run detail, **review the evidence first** (handoff photo links, scan/confirm timestamps, the dispute block's reason + merged refs), then use **ops settle**: pick a mode, enter a reason | Settlement released per the chosen mode; run retires | **Settlements tab** (new settlement), **Ledger tab** (balanced), **Payments tab** (legs + refund row if the mode refunds the buyer), **Disputes tab** (evidence merged server-side) |

Every kobo still comes out of the settlement function — ops settle picks the
mode and supplies the reason; it never moves money directly.

### S4 — Abort → partial-refund rail

| Step | Actor | Action | Expected screen | Watch on dashboard |
|------|-------|--------|-----------------|--------------------|
| 1–4 | As S2 steps 1–4 | Funded run created | — | Payments tab: hold `held` |
| 5 | Owner (runner) | Abort the trip mid-run | Abort settlement computed | Run detail |
| 6 | Owner (ops) | Observe settlement | **Aborts never refund fully**: runner and platform settle partially; buyer gets a partial refund | **Settlements tab**; **Payments tab**: refund row on the refund rail — card charges refund via the provider; non-card methods land in terminal `refund-manual` (ops must act — reconcile reports these as WARN, not FAIL) |

### S5 — Resilience games

Run these one at a time, inside an otherwise happy-path run. After each,
confirm recovery before moving on.

| # | Game | How | Expected behavior | Watch on dashboard |
|---|------|-----|-------------------|--------------------|
| a | Airplane mode in the handoff window | Buyer goes airplane-mode right after the runner scans the delivery QR + photo | 3-minute auto-confirm fires **because a photo is attached** — buyer silence = consent | Run detail: confirm lands ~3 min after scan |
| b | Photoless confirm attempt | Runner scans QR but "forgets" the photo | Handoff stays **pending** and re-arms — no auto-confirm, ever, without a photo | Run detail: `scannedAt` set, no confirm |
| c | App kill mid-run | Buyer force-quits Expo Go mid-run, reopens | State restored from the server (cart/run ids are edge-authoritative — the client re-reads them) | Event feed: reconnect |
| d | Double-tap Pay | Buyer mashes Pay at checkout | One charge. `txRef` is unique; a confirmed hold is reusable — a retry shows "payment confirmed" instead of charging again | **Payments tab**: exactly one hold for the cart |
| e | Wrong-face sign-in | Friend B tries to sign in as Friend A on B's phone | Sandbox verdict is simulated — the interesting observation is whether testers *expect* it to fail | Event feed |
| f | Second-device sign-in | Friend A signs in on a second phone | With `FIDO_UPSERT_ENABLED=true` (identity var, multi-device testing), the new device credential upserts; without it the registration refuses with `credential-exists` and points at device reset | **Resets tab**: a filed device reset appears as a pending request — approve (revokes credentials + sessions) or reject from the console |

### S6 — Ops actions (owner, between tester scenarios)

| # | Action | How | Expected | Watch |
|---|--------|-----|----------|-------|
| a | Vocabulary rename | Ops console → **Markets** button → vocabulary moderation → rename an item | Market vocabulary updates; buyers see the new term | Market overview |
| b | Market config tune | **Markets** button → config (e.g. shorten a timer) | Live MarketDO config updates | Gate-metrics strip, header gate-pass pill |

---

## 5. Known limitations — read these aloud to yourself before the session

These are known, accepted behaviors. Do not burn session time "discovering"
them.

- **L1 — Checkout retry 404s after cart retirement.** If the cart retired
  (deadline, expiry) between a failed checkout and the retry, the retry 404s.
  Recovery: the client re-reads the cart (`GET /markets/:market/cart`) and
  active runs (`GET /markets/:market/runs/active`) — ids are
  edge-authoritative; never trust a stale client id.
- **L2 — In-flight disputes appear at retirement, by doctrine.** Dispute
  persistence landed (ADR-0026): a dispute filed on a live run is held in the
  RunDO and materializes in Postgres when the run retires — the
  retirement-snapshot doctrine, not a gap. The **Disputes tab lights up at run
  close** with the reason and the server-merged evidence refs.
- **L3 — Transfer pending times.** Test-mode transfers sit in `sent`/`queued`
  until the webhook lands or `POST /dispatches/sync` polls them (rows stale >
  15 min by default). Reconcile WARNs past 30 min pending. This is lag, not
  loss — explain it in the session log. With `FLUTTERWAVE_TEST_MODE=true`
  (§0 item 5) the mock webhook lands in ~1 min, so these should be rare.
- **L4 — Face verdicts are simulated.** Sandbox enroll/verify pass on canned
  results; in stub mode the verifier is local. Nothing here validates real
  liveness or matching. Say so in the briefing (§2) and do not draw trust
  conclusions from simulated verdicts.

---

## 6. Incident scripts & abort criteria

### Incident scripts

| # | Symptom | Script |
|---|---------|--------|
| I1 | **Flutterwave webview fails** (buyer cannot reach the charge modal, or charges error immediately) | Flip the paid gate off: remove `PAYMENTS_REQUIRED=true` from `infra/.dev.vars`, restart the stack. Checkout falls back to the unpaid dev posture. **Continue all trust scenarios** (S2 handoffs, S3, S5a–c) — they do not depend on collection. Mark S2-step-4, S4, S5d as not-tested. |
| I2 | **Smile ID sandbox down — or no Smile ID credentials** (face jobs stuck pending / erroring) | Set `FACE_VERIFIER=stub` in `infra/.dev.vars`, restart. Face enroll/verify become synchronous stubs. Note in the session log that identity flows ran stubbed. |
| I3 | **Stuck hold** (a hold stays `held` with no settlement, or a dispatch never resolves) | 1. Run `node infra/reconcile.mjs` — it isolates the exact row and check that fails. 2. Ops-settle the affected run from the dashboard (run detail → ops settle). 3. Re-run reconcile; the hold must now tie out. **If a second stuck hold occurs in the same session: stop all payments scenarios** (flip `PAYMENTS_REQUIRED` off) and continue trust-only. |
| I4 | **Tunnel drops** | Restart the tunnel (Ctrl-C the stack, `dev:all -- --tunnel` again; Postgres state and all server state survive — friends just re-scan the new QR / reload). If using a quick tunnel, re-register the Flutterwave webhook (§1.3) and redistribute the ops link. **Second drop in the session: switch to LAN mode** — same Wi-Fi, `EXPO_PUBLIC_EDGE_URL` = the Mac's LAN IP, no tunnels. |
| I5 | **Tester types a real BVN/NIN** | Prevention is the briefing (§2) — but if it happens: do not panic, do not delete anything mid-session. Note the participant id. Identity stores embeddings encrypted at rest and IDs hash-only; after the session, delete the local Postgres container volume (throwaway dev container) as part of teardown, and say so to the tester. |

### STOP conditions — end the session immediately if any occurs

| Trigger | Why |
|---------|-----|
| **Any double-charge** — two holds or two provider charges for one cart | Violates exactly-once money doctrine; the session's money data is untrustworthy from that point |
| **Stuck hold twice** (I3 escalates) | Systemic hold/settlement break, not a one-off |
| **A photoless confirm ever observed** — a handoff reaching confirmed/settled with no photo attached | Violates ADR-0020 doctrine; the one thing that must never happen |
| **Session crossing between testers** — anyone sees another participant's cart, run, or money | Scoped-discovery/topic-filtering breach (ADR-0021); privacy incident with real humans in the room |
| **Tunnel down twice** | Session logistics are dominating; reschedule rather than burn tester goodwill (or fall back to LAN per I4 if the group is still game) |

On any STOP: thank the testers, end the session, run the post-session steps
(§7) on whatever data exists, and write the incident up before fixing
anything.

---

## 7. Post-session (within the hour)

1. **Tie out the money.** With the full stack still up:

   ```bash
   node infra/reconcile.mjs --json
   ```

   Save the output and **attach it to the session log** (the last line is
   always `RECONCILE_EXIT=0|1`). Expected: exit 0; if the accepted 2026-10-15
   baseline rows are still present, only their known dispatch gaps are
   tolerated (§0 item 3). The pre-alias e2e rows (`provider_reference IS NULL`)
   are also explained baseline evidence; any WARN row with a non-null
   `provider_reference` is not. Every other WARN (pending transfers,
   refund-manual rows, stale holds) must have a one-line explanation in the
   log — the WARN budget is 0 unexplained.

   At the top of the log, record the session posture: identity mode (Smile ID
   sandbox vs stub) and payments gate (`PAYMENTS_REQUIRED` on/off).

2. **Collect feedback while it's fresh** — one row per tester per task:

   | Field | Example |
   |-------|---------|
   | Device | "iPhone 12, Expo Go" |
   | Role | buyer |
   | Task | S2 checkout |
   | Time | 4 min |
   | Completed unassisted? | no — needed hint at OTP |
   | Verbatim quote | "I thought the scan was the confirmation" |

   The verbatim quote is the most valuable column. Do not paraphrase.

3. **Evidence that changes the launch decision** — flag immediately if the
   session produced any of:

   - **H1 evidence — trust features ignored**: testers confirming handoffs
     without looking at the photo/QR, or treating them as ceremony.
   - **H3 evidence — money doesn't tie out**: reconcile FAIL beyond the
     accepted baseline (if it is still present), or any WARN nobody can
     explain.
   - **Workaround habits**: testers inventing off-system paths (calling each
     other instead of using offers, sharing one phone, paying "outside the
     app" as a joke that lands) — workarounds are product signal, not
     misbehavior.

4. **Teardown**: Ctrl-C the stack; delete test data per the consent wording
   (the local Postgres container is the store — `docker rm -v` the container
   if the consent promise requires destruction); delete Expo Go sessions on
   friends' phones if asked.

---

## 8. Hypotheses under test

| # | Hypothesis | Passes if | Kill criteria |
|---|-----------|-----------|---------------|
| H1 | **The QR + photo handshake earns trust** — buyers accept "silence = consent" because evidence exists | Buyers reference the photo/QR unprompted when asked why they trust the delivery | Testers ignore or bypass the handshake (confirm without looking, "just mark it done"), or say they'd still call the seller to verify — trust is being carried by the relationship, not the system |
| H2 | **Untrained users complete the core loop unassisted** — intent → offer → accept → pay → handoff | ≥ 2 buyers and ≥ 1 seller finish S1–S2 with at most one hint each | Any tester needs step-by-step rescue on a core screen, or abandons a task |
| H3 | **The money ties out under real humans** — holds, settlements, refunds, and dispatches reconcile exactly | `reconcile.mjs` exits 0 modulo the accepted baseline; every WARN explained | Any FAIL beyond the baseline, any unexplained kobo, any double-charge — doctrine says this stops the test |
| H4 | **The ops console is sufficient as the session console** — one operator can observe and intervene without touching code | Owner resolves S3's dispute and S4's abort from the dashboard alone | An ops action requires a database query, a curl, or a code read to complete |
| H5 | **The system survives real-network chaos** — interruptions degrade gracefully, never corrupt | S5 games all recover; no stuck state survives its timer | Any unrecoverable run, any photoless confirm, any session crossing between testers |

Kill criteria are session-level: hitting one does not necessarily kill the
product, but it kills the assumption, and the assumption was load-bearing —
write it up the same day.

---

## Appendix — quick reference

| Thing | Where |
|-------|-------|
| Boot | `npx pnpm@9.15.4 dev:all -- --tunnel` |
| Ops console | `https://<tunnel>/ops?token=<OPS_TOKEN>` (printed at boot) |
| Reconcile | `node infra/reconcile.mjs` / `--json` / `--market=Balogun` |
| Secrets | `infra/.dev.vars` (gitignored; all dev workers read it) |
| Mobile env | `apps/mobile/.env` (`EXPO_PUBLIC_EDGE_URL`, `EXPO_PUBLIC_FLW_PUBLIC_KEY`) |
| Webhook | `https://<edge-tunnel>/webhooks/transfers` → edge proxies to payments worker :8790 (no second tunnel; ADR-0026) |
| Transfer polling fallback | `POST /dispatches/sync` (payments worker; stale > 15 min default) |
| Test bank | 044 Access Bank, accounts 0690000031–0690000033 |
| Test OTP | any passes; `6648` = insufficient funds |
| Doctrine references | ADR-0007 (settlement only), 0008 (aborts), 0020 (photo evidence), 0021 (scoping), 0022 (face auth), 0023–0026 (payments + pre-flight fixes) |
