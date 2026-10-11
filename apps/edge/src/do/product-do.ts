import { DurableObject } from "cloudflare:workers";
import { productTtl, type Clock } from "@market-runs/domain";

interface ProductState { productId?: string; intentExpiresAt?: number; createdAt?: number; expiresAt?: number; retired: boolean }

export class ProductDO extends DurableObject<Env> {
  private state: ProductState = { retired: false };
  private readonly clock: Clock = () => Date.now();

  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }
  async fetch(_request: Request): Promise<Response> {
    // TODO(handoff): negotiation, accept-once, and retirement remain serialized here.
    return new Response("ProductDO skeleton", { status: 501 });
  }
  async alarm(): Promise<void> {
    const now = this.clock();
    const scheduledAlarm = await this.ctx.storage.getAlarm();
    this.state = await this.ctx.storage.get<ProductState>("state") ?? this.state;
    if (this.state.createdAt !== undefined && this.state.intentExpiresAt !== undefined) {
      this.state.expiresAt = productTtl(this.state.createdAt, this.state.intentExpiresAt);
      if (now >= this.state.expiresAt) {
        this.state.retired = true;
        await this.ctx.storage.put("state", this.state);
        // TODO(handoff): snapshot Product to the archive queue, then delete DO storage.
        await this.ctx.storage.deleteAll();
        return;
      }
      await this.ctx.storage.put("state", this.state);
      await this.ctx.storage.setAlarm(this.state.expiresAt);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
    void scheduledAlarm;
  }
}
interface Env {}
