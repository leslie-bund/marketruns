import { DurableObject } from "cloudflare:workers";
import { INTENT_TTL_MS, marketCloseGateOk, type Clock } from "@market-runs/domain";

interface Intent { id: string; createdAt: number; expiresAt: number }
interface MarketState { marketId?: string; intents: Intent[]; marketCloseAt?: number; estTripMs?: number; bufferMs?: number }

export class MarketDO extends DurableObject<Env> {
  private state: MarketState = { intents: [] };
  private readonly clock: Clock = () => Date.now();

  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

  async fetch(_request: Request): Promise<Response> {
    // TODO(handoff): load and mutate Market state through the serialized object.
    return new Response("MarketDO skeleton", { status: 501 });
  }

  async alarm(): Promise<void> {
    const now = this.clock();
    const scheduledAlarm = await this.ctx.storage.getAlarm();
    this.state = await this.ctx.storage.get<MarketState>("state") ?? this.state;
    this.state.intents = this.state.intents.map((intent) => ({ ...intent, expiresAt: intent.createdAt + INTENT_TTL_MS })).filter((intent) => intent.expiresAt > now);
    if (this.state.marketCloseAt !== undefined) {
      const checkoutOpen = marketCloseGateOk(now, this.state.marketCloseAt, this.state.estTripMs ?? 0, this.state.bufferMs ?? 0);
      if (!checkoutOpen) {
        // TODO(handoff): enforce the Market close gate for checkout.
      }
    }
    const nextIntentExpiry = this.state.intents.reduce<number | undefined>((next, intent) =>
      next === undefined ? intent.expiresAt : Math.min(next, intent.expiresAt), undefined);
    const gateClosesAt = this.state.marketCloseAt === undefined
      ? undefined
      : this.state.marketCloseAt - (this.state.estTripMs ?? 0) - (this.state.bufferMs ?? 0);
    const nextAlarm = [nextIntentExpiry, gateClosesAt].filter((time): time is number => time !== undefined && time > now).sort((a, b) => a - b)[0];
    await this.ctx.storage.put("state", this.state);
    if (nextAlarm !== undefined) await this.ctx.storage.setAlarm(nextAlarm);
    else await this.ctx.storage.deleteAlarm();
    void scheduledAlarm;
  }
}

interface Env {}
