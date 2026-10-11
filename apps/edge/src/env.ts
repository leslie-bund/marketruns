import type { MarketDO } from "./do/market-do.js";
import type { ProductDO } from "./do/product-do.js";
import type { CartDO } from "./do/cart-do.js";
import type { RunDO } from "./do/run-do.js";

/**
 * Edge runtime bindings (infra/wrangler.edge.toml). Typed against the four
 * Durable Object classes so stubs carry their fetch() protocol.
 */
export interface Env {
  MARKET_DO: DurableObjectNamespace<MarketDO>;
  PRODUCT_DO: DurableObjectNamespace<ProductDO>;
  CART_DO: DurableObjectNamespace<CartDO>;
  RUN_DO: DurableObjectNamespace<RunDO>;
  ARCHIVE_QUEUE: Queue;
  ARCHIVE_BUCKET: R2Bucket;
  MARKET_CONFIG: KVNamespace;
}
