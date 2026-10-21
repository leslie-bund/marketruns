# End-to-end process videos

Short screen recordings of the MVP running on the local dev environment
(`infra/dev-servers.sh`: edge on :8787, archive consumer on :8788, Postgres in
Docker). Both backend videos drive the ops console at
`http://localhost:8787/ops`; the third is the **actual Expo app** (web build)
driven end-to-end against the live edge over the DevTools protocol.

## 01-buyer-seller-flow.mp4 (24s)

1. Ops adjusts an open run to **aborted** through the settlement function only
   — the buyer is refunded ₦2,805.00 of the ₦3,400.00 capture; the runner keeps
   ₦425.00 disruption pay and the platform ₦170.00 (ADR-0008: never a full refund).
2. A fresh buyer/seller flow in a new market (Oyingbo): buyer posts an intent →
   seller offers a product at ₦1,650 → buyer negotiates to ₦1,600 → buyer
   accepts into the cart → checkout at the ₦1,700 floor rate creates the run.

Recorded in headless Chrome over CDP (screencast frames + synthetic input).

## 02-runner-settlement-reputation.mp4 (49s)

The runner wire on a live run, every step a background computer-use click in
the desktop Chrome window: initiate handoff → the 3-minute auto-confirm fires
(buyer silence = consent) while the window is minimized → location tick and
photo evidence attach → final delivery arms the dispute window → ops releases
the settlement (completed) → reputation computed from the durable record.

## 03-mobile-app-end-to-end.mp4 (23s) — the real app

The Expo app itself, all three roles, against the live dev edge:

1. Launch screen with the live-connection pill (● LIVE against :8787).
2. **Buyer**: posts an intent (Tomatoes, ₦1,200–1,800 band).
3. **Seller**: sees the demand instantly, responds with a product at ₦1,650.
4. **Buyer**: the product appears in "Products responding" (the discovery
   index), negotiates to ₦1,600, accepts — the cart's shared lap-timer starts
   at 30:00.
5. **Checkout**: plus-code delivery → run assigned at the ₦1,700 floor rate.
6. **Runner**: the run appears with its ordered stop; the handoff opens with a
   live 3-minute auto-confirm countdown, then confirms (auto-confirm while the
   demo waited — buyer silence = consent), photo evidence attaches, stop
   completes, final delivery → status DELIVERED.

The 30-minute dispute window then runs server-side; the settlement and
reputation update land in Postgres through the archive queue with no further
input.

## Re-recording

```bash
infra/dev-servers.sh                 # edge :8787 + archive :8788 + Postgres
(cd apps/mobile && npx expo start --web --port 8081)   # the app, web build

# native (iOS simulator) — Expo Go must be installed once:
(cd apps/mobile && npx expo start --ios)

# CDP-driven re-record:
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --user-data-dir=/tmp/mr-app --remote-debugging-port=9334 \
  --remote-allow-origins='*' --window-size=1400,1000 --hide-scrollbars "http://localhost:8081"
python docs/videos/cdp_app.py
```

Notes learned building these:

- **Browser clients need CORS** — the edge now mounts `hono/cors()`; native
  apps never noticed its absence.
- **DO storage drifts like a database** — the MarketDO discovery index
  normalizes old stored state on load (`intentProducts ??= {}`).
- **Orphaned workerd processes serve stale code forever** — always stop dev
  servers via `infra/dev-servers.sh --stop` (it sweeps them).
- On web, expo-router `Link asChild` cards don't render anchors; buttons and
  API calls are unaffected.
