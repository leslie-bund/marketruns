import { MarketDO } from "./do/market-do.js";
import { ProductDO } from "./do/product-do.js";
import { CartDO } from "./do/cart-do.js";
import { RunDO } from "./do/run-do.js";

export { MarketDO, ProductDO, CartDO, RunDO };

export interface Env {
  MARKET_DO: DurableObjectNamespace<MarketDO>;
  PRODUCT_DO: DurableObjectNamespace<ProductDO>;
  CART_DO: DurableObjectNamespace<CartDO>;
  RUN_DO: DurableObjectNamespace<RunDO>;
  ARCHIVE_QUEUE: Queue;
  ARCHIVE_BUCKET: R2Bucket;
  MARKET_CONFIG: KVNamespace;
}

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response("Market Runs edge skeleton", { status: 501 });
  },
};
