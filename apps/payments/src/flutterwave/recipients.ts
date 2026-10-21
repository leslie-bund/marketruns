import type { DispatchAccount } from "@market-runs/proto";
import type { RecipientResolver, ResolvedPayoutAccount } from "../recipients.js";

/**
 * Dev-stage RecipientResolver: nothing in the system collects payout accounts
 * yet, so recipient coordinates come from an env map, falling back to
 * Flutterwave's documented TEST bank accounts so a test-mode key can settle
 * the demo seed's parties end to end.
 *
 * Env map (DEV_PAYOUT_RECIPIENTS, JSON object keyed by partyId):
 *   {"seller:amina":{"bank":"044","account":"0690000031","name":"Amina"}, …}
 * Env entries win per partyId; the test-account defaults below fill the rest.
 * Malformed JSON or entry shapes throw at construction — a payout misconfig
 * must be loud, never silently misdirect money.
 *
 * The fallback entries are Flutterwave's published test accounts (Access Bank
 * code 044, accounts 0690000031–0690000033 — test mode ONLY; OTP 12345).
 * They move no real money. Real payout-details collection in onboarding
 * (ParticipantDO → Postgres) is the deliberate follow-up; until then an
 * unknown partyId resolves to null and the dispatch fails
 * "recipient-unresolved", replayable once the map is fixed.
 */

interface DevRecipientEntry {
  bank: string;
  account: string;
  name?: string;
}

/** Flutterwave-documented test accounts for the demo seed's parties (test mode only). */
const FLUTTERWAVE_TEST_ACCOUNT_DEFAULTS: Readonly<Record<string, DevRecipientEntry>> = {
  "seller:amina": { bank: "044", account: "0690000031", name: "TEST — Forrest Green" },
  "runner:internal": { bank: "044", account: "0690000032", name: "TEST — Pastor Bright" },
  platform: { bank: "044", account: "0690000033", name: "TEST — platform" },
};

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

  constructor(envJson?: string) {
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
    this.entries = { ...FLUTTERWAVE_TEST_ACCOUNT_DEFAULTS, ...parsed };
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
