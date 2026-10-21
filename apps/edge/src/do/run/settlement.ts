import { MVP_ABORT_SPLIT } from "@market-runs/domain";
import type { SettlementInput } from "@market-runs/domain";
import type { RunState } from "./state.js";

/**
 * Settlement construction for a Run: the SettlementInput for a mode is built
 * from the run's actual legs and seeded coefficients. Non-completed modes
 * carry the MVP abort split and, for disputed mode, the evidence outcome
 * (ADR-0007). Pure over state — the RunDO owns orchestration.
 */
export function buildSettlementInput(
  state: RunState,
  mode: "completed" | "aborted" | "disputed",
  dispute?: SettlementInput["dispute"],
): SettlementInput {
  const run = state.run;
  const config = state.settlementConfig;
  if (!run || !config) throw new Error("run has no settlement configuration");
  return {
    mode,
    sellers: state.legs.map((leg) => ({
      sellerId: leg.sellerId,
      amountKobo: leg.amountKobo,
      stopCompleted:
        run.stops.find((stop) => stop.sellerName === leg.sellerId)?.status === "completed",
    })),
    deliveryPriceKobo: run.floorRateKobo,
    deliveryMarginKobo: config.deliveryMarginKobo,
    goodsCommissionBps: config.goodsCommissionBps,
    ...(mode !== "completed" ? { abortSplit: MVP_ABORT_SPLIT } : {}),
    ...(dispute ? { dispute } : {}),
  };
}

