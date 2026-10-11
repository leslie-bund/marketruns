import type { SettlementInput, SettlementOutcome } from "@market-runs/domain";

/** Vendor-neutral seam. Implementations accept and release money only from Settlement inputs. */
export interface PaymentsProvider {
  collectCartPayment(cartId: string, amountKobo: number): Promise<{ reference: string }>;
  applySettlement(runId: string, input: SettlementInput): Promise<SettlementOutcome>;
}

export const paymentsStub: PaymentsProvider = {
  async collectCartPayment(cartId, amountKobo) {
    return { reference: `fixture-payment:${cartId}:${amountKobo}` };
  },
  async applySettlement(_runId, input) {
    const { settle } = await import("@market-runs/domain");
    return settle(input);
  },
};
