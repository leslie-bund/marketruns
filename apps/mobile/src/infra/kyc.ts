export type KycStatus = "not-started" | "pending" | "verified" | "needs-review";

/** Vendor-neutral identity verification seam. */
export interface KycProvider {
  getStatus(participantId: string): Promise<KycStatus>;
  beginVerification(participantId: string): Promise<{ reference: string }>;
}

export const kycStub: KycProvider = {
  async getStatus(_participantId) { return "not-started"; },
  async beginVerification(participantId) { return { reference: `fixture-kyc:${participantId}` }; },
};
