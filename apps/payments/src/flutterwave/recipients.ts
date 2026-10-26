import type { DispatchAccount } from "@market-runs/proto";
import type { RecipientResolver, ResolvedPayoutAccount } from "../recipients.js";

/**
 * Dev-stage RecipientResolver: nothing in the system collects payout accounts
 * yet, so recipient coordinates come from an env map, falling back to
 * Flutterwave's documented TEST bank accounts so a test-mode key can settle
 * the demo seed's parties end to end.
 *
 * Env map (DEV_PAYOUT_RECIPIENTS, JSON object keyed by partyId):
 *   {"Amina's Fresh Store":{"bank":"044","account":"0690000031","name":"Amina"}, …}
 * Env entries win per partyId; the test-account defaults below fill the rest.
 * Malformed JSON or entry shapes throw at construction — a payout misconfig
 * must be loud, never silently misdirect money.
 *
 * Current seller legs carry authoritative participant ids; legacy fixtures may
 * still carry display names. The defaults below cover both forms of the demo
 * seed with Flutterwave's published test accounts (Access Bank code 044,
 * accounts 0690000031–0690000033 — test mode ONLY; OTP 12345). They are
 * included only for a test key, so a live key can never pay a mock recipient.
 * Real payout-details collection remains DB-first by participant id
 * (ADR-0025). An unknown partyId fails "recipient-unresolved" and can be
 * replayed after the participant saves a valid account.
 */

interface DevRecipientEntry {
  bank: string;
  account: string;
  name?: string;
}

/** Flutterwave-documented test accounts for the demo seed's parties (test mode only). */
const FLUTTERWAVE_TEST_ACCOUNT_DEFAULTS: Readonly<Record<string, DevRecipientEntry>> = {
  // Both legacy display-name legs and current participant-owned demo stores.
  "Amina's Fresh Store": { bank: "044", account: "0690000031", name: "TEST — Forrest Green" },
  "participant:demo-amina": { bank: "044", account: "0690000031", name: "TEST — Forrest Green" },
  "Mama Ngozi Provisions": { bank: "044", account: "0690000032", name: "TEST — Pastor Bright" },
  "participant:demo-ngozi": { bank: "044", account: "0690000032", name: "TEST — Pastor Bright" },
  "Emeka Phones & Accessories": { bank: "044", account: "0690000033", name: "TEST — platform" },
  "participant:demo-emeka": { bank: "044", account: "0690000033", name: "TEST — platform" },
  // Retained for tests and pre-ADR-0018 fixtures that still use the old id.
  "seller:amina": { bank: "044", account: "0690000031", name: "TEST — Forrest Green" },
  "runner:internal": { bank: "044", account: "0690000032", name: "TEST — Pastor Bright" },
  platform: { bank: "044", account: "0690000033", name: "TEST — platform" },
};

export interface DevRecipientResolverOptions {
  /**
   * Include the documented test-account defaults. Defaults to true for direct
   * use/tests; the vendor integration enables it only for FLWSECK_TEST keys,
   * so a live key can never pay a mock account.
   */
  includeTestDefaults?: boolean;
}

function parseEntry(partyId: string, raw: unknown): DevRecipientEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`DEV_PAYOUT_RECIPIENTS["${partyId}"] must be an object { bank, account, name? }`);
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.bank !== "string" || entry.bank.trim() === "") {
    throw new Error(`DEV_PAYOUT_RECIPIENTS["${partyId}"].bank must be a non-empty string`);
  }
  if (typeof entry.account !== "string" || entry.account.trim() === "") {
    throw new Error(`DEV_PAYOUT_RECIPIENTS["${partyId}"].account must be a non-empty string`);
  }
  const name = entry.name;
  if (name !== undefined && typeof name !== "string") {
    throw new Error(`DEV_PAYOUT_RECIPIENTS["${partyId}"].name must be a string when present`);
  }
  return {
    bank: entry.bank.trim(),
    account: entry.account.trim(),
    ...(typeof name === "string" && name.trim() !== "" ? { name: name.trim() } : {}),
  };
}

export class DevRecipientResolver implements RecipientResolver {
  private readonly entries: Readonly<Record<string, DevRecipientEntry>>;

  constructor(envJson?: string, options: DevRecipientResolverOptions = {}) {
    let parsed: Record<string, DevRecipientEntry> = {};
    const raw = envJson?.trim();
    if (raw) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch (error) {
        throw new Error(`DEV_PAYOUT_RECIPIENTS is not valid JSON: ${String(error)}`);
      }
      if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
        throw new Error("DEV_PAYOUT_RECIPIENTS must be a JSON object keyed by partyId");
      }
      for (const [partyId, value] of Object.entries(decoded)) {
        parsed[partyId] = parseEntry(partyId, value);
      }
    }
    // Per-key fallback: env entries override the labelled test accounts.
    const defaults = (options.includeTestDefaults ?? true) ? FLUTTERWAVE_TEST_ACCOUNT_DEFAULTS : {};
    this.entries = { ...defaults, ...parsed };
  }

  resolve(partyId: string, _account: DispatchAccount): Promise<ResolvedPayoutAccount | null> {
    const entry = this.entries[partyId];
    if (!entry) return Promise.resolve(null);
    return Promise.resolve({
      accountBank: entry.bank,
      accountNumber: entry.account,
      ...(entry.name !== undefined ? { accountName: entry.name } : {}),
    });
  }
}
