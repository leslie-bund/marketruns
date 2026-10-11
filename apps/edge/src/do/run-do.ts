import { DurableObject } from "cloudflare:workers";
import { DISPUTE_WINDOW_MS, HANDOFF_AUTO_CONFIRM_MS, settle, type Clock, type SettlementInput, type SettlementOutcome } from "@market-runs/domain";

interface Handoff { id: string; exchangePointId: string; createdAt: number; deadline: number; confirmed: boolean }
interface RunState { runId?: string; handoffs: Handoff[]; finalDeliveryAt?: number; settlementReleased: boolean; settlementInput?: SettlementInput; settlement?: SettlementOutcome; location?: { latitude: number; longitude: number; observedAt: number } }

export class RunDO extends DurableObject<Env> {
  private state: RunState = { handoffs: [], settlementReleased: false };
  private readonly clock: Clock = () => Date.now();

  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }
  async fetch(_request: Request): Promise<Response> {
    // TODO(handoff): keep Run structured so a future Trip Auction seam can attach without MVP auction logic.
    return new Response("RunDO skeleton", { status: 501 });
  }
  async alarm(): Promise<void> {
    const now = this.clock();
    const scheduledAlarm = await this.ctx.storage.getAlarm();
    this.state = await this.ctx.storage.get<RunState>("state") ?? this.state;
    for (const handoff of this.state.handoffs) handoff.deadline = handoff.createdAt + HANDOFF_AUTO_CONFIRM_MS;
    for (const handoff of this.state.handoffs) {
      if (!handoff.confirmed && now >= handoff.deadline) {
        handoff.confirmed = true; // Buyer silence = consent.
        // TODO(handoff): persist auto-confirm and advance the Run.
      }
    }
    if (this.state.finalDeliveryAt !== undefined && !this.state.settlementReleased) {
      const releaseAt = this.state.finalDeliveryAt + DISPUTE_WINDOW_MS;
      if (now >= releaseAt) {
        if (this.state.settlementInput !== undefined) {
          this.state.settlement = settle(this.state.settlementInput);
          this.state.settlementReleased = true;
        }
        // TODO(handoff): deliver the Settlement outcome through the release integration.
      }
    }
    const deadlines = [
      ...this.state.handoffs.filter((handoff) => !handoff.confirmed).map((handoff) => handoff.deadline),
      ...(this.state.finalDeliveryAt !== undefined && !this.state.settlementReleased ? [this.state.finalDeliveryAt + DISPUTE_WINDOW_MS] : []),
    ].filter((deadline) => deadline > now);
    const next = deadlines.sort((a, b) => a - b)[0];
    await this.ctx.storage.put("state", this.state);
    if (next === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
    void scheduledAlarm;
  }
}
interface Env {}
