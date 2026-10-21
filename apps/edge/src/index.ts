/**
 * Worker entry. The Hono app is the fetch handler; the five Durable Objects
 * are exported for the runtime (infra/wrangler.edge.toml).
 */
import { createApp } from "./app/app.js";

export { MarketDO, ProductDO, CartDO, RunDO, ParticipantDO } from "./do/index.js";
export type { Env } from "./config/env.js";

export default createApp();
