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
 * At this stage the settlement legs carry the store's trading identity
 * (`sellerName`, ADR-0014/0018), so seller party ids are store display names,
 * not participant ids. The defaults below therefore cover the demo seed's
 * stores by name; they are Flutterwave's published test accounts (Access Bank
 * code 044, accounts 0690000031–0690000033 — test mode ONLY; OTP 12345).
 * They are included only when the configured secret key is a test key, so a
 * live key can never send money to a mock recipient. Payout-details collection
 * is DB-first (ADR-0025) but keyed by participant id; the store→participant
 * mapping is the remaining follow-up. Until it lands, a seller with a saved
 * payout account still resolves null for a display-name leg and must be
 * covered by DEV_PAYOUT_RECIPIENTS. An unknown partyId resolves to null and
 * the dispatch fails "recipient-unresolved", replayable once the map is fixed.
 */

interface DevRecipientEntry {
  bank: string;
  account: string;
  name?: string;
}

/** Flutterwave-documented test accounts for the demo seed's parties (test mode only). */
const FLUTTERWAVE_TEST_ACCOUNT_DEFAULTS: Readonly<Record<string, DevRecipientEntry>> = {
  // The demo seed's seller legs carry the store display name (ADR-0014/0018).
  "Amina's Fresh Store": { bank: "044", account: "0690000031", name: "TEST — Forrest Green" },
  "Mama Ngozi Provisions": { bank: "044", account: "0690000032", name: "TEST — Pastor Bright" },
  "Emeka Phones & Accessories": { bank: "044", account: "0690000033", name: "TEST — platform" },
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
