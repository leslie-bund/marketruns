# Market Runs Mobile

Expo React Native single-client app for the Buyer, Seller, and Runner roles. It talks to the real edge worker over the public wire (`src/api/client.ts` → `POST /command` + scoped GETs); there is no fixture backend.

## Quickstart

```bash
# from the repo root — installs all workspaces, including this app
npx pnpm@9.15.4 install

# start the backend (Postgres + migrations + edge :8787 + archive :8788 + demo seed)
npx pnpm@9.15.4 dev:all

# point the app at the backend
cp .env.example .env          # default: http://localhost:8787 (simulator)

cd apps/mobile
npx expo start                # then press i (simulator) or scan the QR in Expo Go
```

`EXPO_PUBLIC_EDGE_URL` is baked into the bundle at startup — **restart Metro after changing `.env`**. The three connection scenarios (simulator / same-Wi-Fi phone / tunnel) are documented in `.env.example`.

## Demoing to friends (two tunnels)

Phones outside your Wi-Fi need a tunnel on **both** sides:

1. Backend: `npx pnpm@9.15.4 dev:all -- --tunnel` — prints a `https://….trycloudflare.com` URL and a guarded ops-console link. Put that URL in `.env` as `EXPO_PUBLIC_EDGE_URL`.
2. App: `npx expo start --tunnel` — needs `@expo/ngrok` (first run offers to install it, or `npx pnpm@9.15.4 add -D @expo/ngrok --filter @market-runs/mobile`). Friends scan the QR with Expo Go.

## Using the app

- **Onboarding (KYC, ADR-0004):** tap "Get started", pick a role, enter a display name and any 11-digit BVN/NIN. On a real device the facial capture uses the camera; on a simulator/browser a dev-only "Use dev capture" button attaches a placeholder capture. The dev verifier accepts any 11-digit document plus a capture. After KYC passes, a "Set up sign-in" step enrolls your face (one selfie, camera-only) and silently registers a device key — the secret lives in expo-secure-store, never AsyncStorage.
- **Sign-in:** once onboarded, the launch screen shows a "Welcome back" card whenever there's no live session — sign in with face (`/auth/face/verify`) or with this device's key (`/auth/device-key/authenticate`). The returned session token rides every request as `Authorization: Bearer` alongside the participant headers; a 401 session-expired/session-invalid clears it and the card returns. Lost the device? "Request a device reset" files an ops-reviewed reset (`/auth/device-reset`).
- **Buyer checkout payment (ADR-0025):** set `EXPO_PUBLIC_FLW_PUBLIC_KEY` in `.env` (see `.env.example`) and checkout collects payment first — card / bank transfer / USSD via Flutterwave Standard in a webview — then the edge confirms the charge server-side before the run is created. An authenticated CartDO quote covers goods + the current routed/floor-rate delivery without settlement margins; its id and expiry are reused at checkout to prevent repricing divergence. Cart-scoped payment references and confirmation state survive remounts, ambiguous results recover by server confirmation, and a shortfall collects only a top-up whose hold is included in settlement/refund processing. Unset key = unpaid dev checkout, matching the edge's `PAYMENTS_REQUIRED=off` default.
- **Seller payout account (ADR-0025):** seller join ends with an optional payout-account step — pick a bank, verify the account number, confirm the returned name, save. Seller home shows the masked account with a change path; selling is never blocked without one.
- **Roles:** Buyer posts intents and builds a cart, Seller responds with products and negotiates, Runner claims pool work before collecting the cart and completing QR-challenge handoffs. Before you onboard, each role is explorable under a demo identity (`src/api/config.ts`), including the pre-assigned `runner:internal` demo.
- **Markets and presence:** role selection goes through the registry-backed Markets screen, which shows live seller counts and opening hours. Authenticated sellers attach their owned market-scoped `storeId` to discovery and sockets; foreground heartbeats refresh presence every 30 seconds. `infra/dev-all.sh` seeds demo stores so the Balogun vocabulary isn't empty on a fresh backend.
- **Notifications:** the signed-in launch screen links to the durable notification centre with an unread badge. Socket opens, reconnects, and app foreground returns refresh the durable list; no Expo Push service is used.
- **Ops dashboard:** `http://localhost:8787/ops` on the Mac (when tunneled, use the `/ops?token=…` URL the backend prints).
- **Scripted walkthrough (dev-only):** open the `/demo` route as a deep link (`exp://<metro-host>/demo`) and the app drives a full buyer → seller → checkout → runner flow through the real API.

Camera access is requested only where a capture happens (onboarding face, runner handoff evidence). The app never requests photo-library access. Buyer delivery locations are Plus Codes or a Muster Point.

## Checks and device validation

```bash
npx --yes pnpm@9.15.4 --filter @market-runs/mobile typecheck
npx --yes pnpm@9.15.4 --filter @market-runs/mobile test
```

The lightweight tests cover runner queue partitioning, claim-safe selection, ownership gates, and the legacy demo runner. Real-device validation still needs to cover: authenticated seller sockets and seller-count expiry across background/foreground; two pool runners attempting the same claim (exactly one succeeds); QR/photo handoffs and GPS after claim; and notification deep links plus unread reconciliation after connectivity loss.
