# Market Runs Mobile

Expo React Native single-client app for Buyer, Seller, and Runner roles. Start with `pnpm start` in this directory and open it in Expo Go.

The current client uses the typed fixture-backed API in `src/api/`. Replace its implementations with the Worker API when that backend is available. The `src/infra/` payment and KYC modules are vendor-neutral seams; settlement stays in `@market-runs/domain`.

Camera access is requested only on the Runner Handoff screen. The app does not request photo-library access. Buyer delivery locations are Plus Codes or a Muster Point.
