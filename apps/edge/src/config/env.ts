import type { MarketDO } from "../do/market-do.js";
import type { ProductDO } from "../do/product-do.js";
import type { CartDO } from "../do/cart-do.js";
import type { RunDO } from "../do/run/run-do.js";
import type { ParticipantDO } from "../do/participant-do.js";

/**
 * Edge runtime bindings (infra/wrangler.edge.toml). Typed against the four
 * Durable Object classes so stubs carry their fetch() protocol.
 */
export interface Env {
  /** Explicit deployed topology validation; unset/development/test keeps local URLs. */
  EDGE_ENV?: string;
  MARKET_DO: DurableObjectNamespace<MarketDO>;
  PRODUCT_DO: DurableObjectNamespace<ProductDO>;
  CART_DO: DurableObjectNamespace<CartDO>;
  RUN_DO: DurableObjectNamespace<RunDO>;
  PARTICIPANT_DO: DurableObjectNamespace<ParticipantDO>;
  ARCHIVE_QUEUE: Queue;
  /** Payment dispatch requests (payment.dispatch-requested) → apps/payments consumer. */
  PAYMENT_QUEUE: Queue;
  /** Trusted lifecycle events → durable notifications worker. Optional in legacy unit-test envs. */
  NOTIFICATION_QUEUE?: Queue;
  ARCHIVE_BUCKET: R2Bucket;
  MARKET_CONFIG: KVNamespace;
  /** Archive service base URL for the ops console reputation panel (dev: wrangler dev of apps/archive). */
  OPS_ARCHIVE_URL?: string;
  /** Payments service base URL for the ops console payments proxy (dev default: http://localhost:8790). */
  PAYMENTS_URL?: string;
  /** Shared edge → payments secret for resolved-participant payout-account routes. */
  PAYMENTS_INTERNAL_TOKEN?: string;
  /** Durable notification read API and participant realtime callback. */
  NOTIFICATIONS_URL?: string;
  NOTIFICATION_INTERNAL_TOKEN?: string;
  /**
   * Checkout payment gate: when truthy ("1"/"true"), checkout.requested must
   * carry `paymentRef` naming a payments-worker hold that covers the
   * checkout total (goods + delivery), and the hold is bound to the run.
   * UNSET/empty/"false" is the dev default: checkout works unpaid, exactly as
   * before — demo flows and e2e tests run without a PSP.
   */
  PAYMENTS_REQUIRED?: string;
  /** Identity service base URL for the /auth/* proxy (dev default: http://localhost:8789). */
  IDENTITY_URL?: string;
  /**
   * HMAC-SHA256 secret for identity session tokens, SHARED with the identity
   * worker so the edge verifies sessions locally (no per-request round trip).
   * Unset in local dev falls back to the same public dev default the identity
   * worker ships; set via `wrangler secret put IDENTITY_SESSION_SECRET` in any
   * deployed environment.
   */
  IDENTITY_SESSION_SECRET?: string;
  /** Explicit local dev/test only. Deployed default is Bearer-only. */
  ALLOW_HEADER_AUTH?: string;
  /** Neon direct connection for CLI/dev; deployed Workers use Hyperdrive. */
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
  /** Key for HMAC-SHA256 BVN/NIN digests; raw identity numbers are never persisted. */
  ID_DOCUMENT_HMAC_SECRET?: string;
  /**
   * Shared secret for the identity worker's internal routes (face enrollment,
   * the device-reset queue read, device-reset decisions — requireInternal,
   * ADR-0022). SHARED with the identity worker: the /auth/* proxy injects it
   * as `x-identity-internal` on those routes only. Unset in local dev =
   * nothing injected and the routes stay open (the identity worker's own
   * posture). When set it must be the SAME value on edge and identity — set
   * via `wrangler secret put IDENTITY_INTERNAL_TOKEN` on both workers.
   */
  IDENTITY_INTERNAL_TOKEN?: string;
  /**
   * OSRM base URL for routing at checkout. Dev points at the free public demo
   * server (infra/osrm/README.md); production points at the self-hosted
   * deployment. Unset = routing disabled, static floor-rate estimates apply.
   */
  OSRM_BASE_URL?: string;
  /** Better Auth secret, minimum 32 characters; OPS ONLY, never participant auth. */
  OPS_AUTH_SECRET?: string;
  /** Public edge origin used by Better Auth for cookies/origin checks. */
  OPS_BASE_URL?: string;
  /** Explicit local-only switches; both must be true for legacy test identity. */
  OPS_LOCAL_DEV?: string;
  OPS_LEGACY_DEV?: string;
  /** Legacy local test token only; Better Auth is the deployed ops guard. */
  OPS_TOKEN?: string;
}
