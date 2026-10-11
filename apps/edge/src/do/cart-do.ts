import { DurableObject } from "cloudflare:workers";
import { cartDeadline, type Clock } from "@market-runs/domain";

interface CartState { cartId?: string; productIds: string[]; firstAcceptedAt?: number; acceptanceCount: number; deadline?: number; retired: boolean }

export class CartDO extends DurableObject<Env> {
  private state: CartState = { productIds: [], acceptanceCount: 0, retired: false };
  private readonly clock: Clock = () => Date.now();

  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }
  async fetch(_request: Request): Promise<Response> {
    // TODO(handoff): acceptance appends a Product and resets the shared Cart deadline.
    return new Response("CartDO skeleton", { status: 501 });
  }
  async alarm(): Promise<void> {
    const scheduledAlarm = await this.ctx.storage.getAlarm();
    this.state = await this.ctx.storage.get<CartState>("state") ?? this.state;
    if (this.state.firstAcceptedAt === undefined || this.state.acceptanceCount < 1) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    this.state.deadline = cartDeadline(this.state.firstAcceptedAt, this.state.acceptanceCount);
    if (this.clock() >= this.state.deadline) {
      this.state.retired = true;
      // TODO(handoff): retire every unbought Product atomically; retired Products never resurrect.
      this.state.productIds = [];
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.put("state", this.state);
    await this.ctx.storage.setAlarm(this.state.deadline);
    void scheduledAlarm;
  }
}
interface Env {}
