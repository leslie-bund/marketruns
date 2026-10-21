import type { DispatchAccount } from "@market-runs/proto";

/**
 * Recipient resolution seam: dispatch legs carry a `partyId` (participant id),
 * never bank details — nothing in the system collects payout accounts yet.
 * A RecipientResolver turns a party into provider-ready account coordinates
 * at the vendor boundary, keeping payout-account collection out of the
 * settlement path.
 *
 * Unresolved recipients are honest failures: the dispatcher returns
 * `failed` with failureReason RECIPIENT_UNRESOLVED, visible in ops and
 * replayable once the party's payout account is registered.
 *
 * Follow-up (not built): real payout-details collection during onboarding
 * (ParticipantDO), persisted per participant, resolved here from Postgres.
 */

/** Provider-ready payout account coordinates for one party. */
export interface ResolvedPayoutAccount {
  /** Provider bank/institution code for the destination account. */
  accountBank: string;
  accountNumber: string;
  accountName?: string;
}

export interface RecipientResolver {
  /** Resolve a dispatch leg's party to payout coordinates; null when unknown. */
  resolve(partyId: string, account: DispatchAccount): Promise<ResolvedPayoutAccount | null>;
}

/** failureReason recorded when no payout account exists for a leg's party. */
export const RECIPIENT_UNRESOLVED = "recipient-unresolved";

/**
 * First-non-null composition of resolvers: DB-first (saved payout accounts),
 * then the dev env-map/test-account fallback. An unresolved party still fails
 * honestly as recipient-unresolved.
 */
export class ChainRecipientResolver implements RecipientResolver {
  constructor(private readonly resolvers: RecipientResolver[]) {}

  async resolve(partyId: string, account: DispatchAccount): Promise<ResolvedPayoutAccount | null> {
    for (const resolver of this.resolvers) {
      const resolved = await resolver.resolve(partyId, account);
      if (resolved) return resolved;
    }
    return null;
  }
}
