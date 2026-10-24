/**
 * RunDO state shapes. Live trip state only; at close the settlement and the
 * final snapshot leave through the archive queue, then DO storage is deleted
 * (ADR-0010).
 */

import type { Run } from "@market-runs/proto";

export interface InternalHandoff {
  id: string;
  exchangePointId: string;
  counterparty: string;
  status: "pending" | "confirmed";
  requestedAt: number;
  /** R2 reference string only — media bytes never pass through the RunDO. */
  photoCaptureRef?: string;
  photoCapturedAt?: number;
  scannedAt?: number;
  autoConfirmed?: boolean;
  confirmedAt?: number;
}

export interface SettlementConfig {
  goodsCommissionBps: number;
  deliveryMarginKobo: number;
}

export interface RunState {
  run?: Run;
  /** Per-seller goods totals for the settlement function. */
  legs: Array<{ sellerId: string; amountKobo: number }>;
  settlementConfig?: SettlementConfig;
  /** Durable identities carried to settlement.released and run.retired. */
  buyerId?: string;
  runnerId?: string | null;
  startedAt?: number;
  storeIds?: string[];
  handoffs: InternalHandoff[];
  finalDeliveryAt?: number;
  settlementReleased: boolean;
  disputed: boolean;
  /** Who raised the dispute (header-resolved at the edge, ADR-0015), when known. */
  disputeRaisedByParticipantId?: string;
  /**
   * Correlation id of the checkout request that seeded this run (x-request-id,
   * forwarded by the CartDO). Carried onto the settlement/dispatch queue
   * messages so a timer-driven close still joins the checkout's trace.
   */
  requestId?: string;
  /** The dispute's stated reason, kept for the retirement snapshot's dispute context. */
  disputeReason?: string;
  /**
   * Evidence gathered at dispute time (ADR-0007): every handoff photo ref on
   * the run plus any refs the raiser attached. Carried to the archive on
   * run.retired so the disputes table's evidence_refs can be written from it.
   */
  disputeEvidenceRefs?: string[];
  /** Deterministic-time seam: epoch offset added to Date.now(). 0 in production. */
  timeOffsetMs?: number;
}
