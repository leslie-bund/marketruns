import { eq } from "drizzle-orm";
import type { PayoutAccountView } from "@market-runs/proto";
import type { DispatchAccount } from "@market-runs/proto";
import { payoutAccounts } from "../../../infra/drizzle/schema.js";
import type { createDatabase } from "./db.js";
import type { RecipientResolver, ResolvedPayoutAccount } from "./recipients.js";

/**
 * Saved payout accounts: one per participant, stored ONLY after provider-side
 * account-name resolution (an unresolved account is never persisted — a wrong
 * account silently misdirects settlement money). This table is the
 * RecipientResolver's DB-first source (ADR-0024's recorded follow-up): the
 * env-map/test-account DevRecipientResolver remains as the dev fallback, and
 * an unknown party still fails honestly as `recipient-unresolved`.
 */

export interface PayoutAccountRow {
  participantId: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  verifiedAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PayoutAccountStore {
  /** Insert or replace the participant's account (re-saving re-verifies first — caller's job). */
  upsert(row: PayoutAccountRow): Promise<void>;
  /** The participant's ACTIVE account; revoked accounts do not resolve. */
  byParticipantId(participantId: string): Promise<PayoutAccountRow | null>;
  /** Revoke the account (soft delete); false when no active account exists. */
  revoke(participantId: string): Promise<boolean>;
}

/** Row → wire view; full bank details stay server-side for dispatch only. */
export function payoutAccountView(row: PayoutAccountRow): PayoutAccountView {
  const accountNumber = row.accountNumber.length <= 4
    ? "****"
    : `${"*".repeat(row.accountNumber.length - 4)}${row.accountNumber.slice(-4)}`;
  return {
    participantId: row.participantId,
    bankCode: row.bankCode,
    accountNumber,
    accountName: row.accountName,
    verifiedAt: row.verifiedAt.getTime(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.getTime(),
  };
}

type Database = ReturnType<typeof createDatabase>["db"];

/** Postgres-backed store over the payout_accounts table (ADR-0011). */
export class DrizzlePayoutAccountStore implements PayoutAccountStore {
  constructor(private readonly db: Database) {}

  async upsert(row: PayoutAccountRow): Promise<void> {
    await this.db
      .insert(payoutAccounts)
      .values(row)
      .onConflictDoUpdate({
        target: payoutAccounts.participantId,
        set: {
          bankCode: row.bankCode,
          accountNumber: row.accountNumber,
          accountName: row.accountName,
          verifiedAt: row.verifiedAt,
          revokedAt: null,
          updatedAt: new Date(),
        },
      });
  }

  async byParticipantId(participantId: string): Promise<PayoutAccountRow | null> {
    const rows = await this.db
      .select()
      .from(payoutAccounts)
      .where(eq(payoutAccounts.participantId, participantId))
      .limit(1);
    const row = rows[0] as PayoutAccountRow | undefined;
    if (!row || row.revokedAt !== null) return null;
    return row;
  }

  async revoke(participantId: string): Promise<boolean> {
    const updated = await this.db
      .update(payoutAccounts)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(payoutAccounts.participantId, participantId))
      .returning({ participantId: payoutAccounts.participantId });
    return updated.length > 0;
  }
}

/**
 * DB-first RecipientResolver: resolves a dispatch leg's party from
 * payout_accounts. Returns null for unknown or revoked accounts — the chain
 * falls through to the dev resolvers, and ultimately to recipient-unresolved.
 */
export class DbRecipientResolver implements RecipientResolver {
  constructor(private readonly accounts: PayoutAccountStore) {}

  async resolve(partyId: string, _account: DispatchAccount): Promise<ResolvedPayoutAccount | null> {
    const row = await this.accounts.byParticipantId(partyId);
    if (!row) return null;
    return { accountBank: row.bankCode, accountNumber: row.accountNumber, accountName: row.accountName };
  }
}
