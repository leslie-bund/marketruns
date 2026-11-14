/**
 * Dev-environment connection settings.
 *
 * EXPO_PUBLIC_EDGE_URL overrides the edge worker base URL (set it in
 * .env to your LAN IP when testing on a physical device, e.g.
 * EXPO_PUBLIC_EDGE_URL=http://192.168.1.5:8787). The default works on the
 * iOS simulator and Expo web; Android emulators need http://10.0.2.2:8787.
 */
export const EDGE_URL = (process.env.EXPO_PUBLIC_EDGE_URL ?? "http://localhost:8787").replace(/\/$/, "");

/**
 * Flutterwave public key for buyer checkout collection (public keys are
 * embed-safe). Set EXPO_PUBLIC_FLW_PUBLIC_KEY in .env; when unset the
 * checkout screen stays on the unpaid dev flow (the edge's PAYMENTS_REQUIRED
 * gate is off in dev) instead of offering a Pay button that cannot work.
 */
export const FLW_PUBLIC_KEY = (process.env.EXPO_PUBLIC_FLW_PUBLIC_KEY ?? "").trim();
export const paymentsConfigured = FLW_PUBLIC_KEY.length > 0;

/** The MVP launches in exactly one market (ADR-0013); devices may join others. */
export const DEFAULT_MARKET = "Balogun";

export const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
