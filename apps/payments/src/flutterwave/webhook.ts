import { z } from "zod";
import { PROVIDER_REF_PREFIX } from "./dispatcher.js";

/**
 * Flutterwave transfer webhooks (vendor quarantine — ADR-0009).
 *
 * Verification (v3): the dashboard's webhook "secret hash" is echoed verbatim
 * in the `verif-hash` request header — a shared-secret comparison, NOT an
 * HMAC over the body. Consequences we accept knowingly: the hash must be
 * stored/transported as carefully as a password, and a leaked hash can forge
 * payloads until rotated. We compare SHA-256 digests of both sides so the
 * check is constant-time and never logs the raw secret.
 *
 * Payload shapes accepted:
 *   v3: { event: "transfer.completed", "event.type": "Transfer",
 *         data: { id: <number>, reference, status: "SUCCESSFUL"|"FAILED",
 *                 complete_message } }
 *   v4: { type: "transfer.disburse",
 *         data: { id: "trf_…", reference, status } }
 * Only terminal transfer outcomes update rows; anything else is acknowledged
 * and ignored (a non-2xx would make the provider retry forever).
 */

const TransferWebhookDataSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  reference: z.string().optional(),
  status: z.string().optional(),
  complete_message: z.string().nullable().optional(),
});

const V3WebhookSchema = z.object({
  event: z.string().optional(),
  "event.type": z.string().optional(),
  type: z.string().optional(),
  data: TransferWebhookDataSchema.nullable().optional(),
});

/** A terminal transfer outcome carried by a webhook. */
export interface TransferWebhookOutcome {
  /** Provider-facing reference alias (the transfer `reference` we sent at creation). */
  reference: string | null;
  /** Full providerRef (`flw:<id>`) for fallback row matching. */
  providerRef: string | null;
  status: "completed" | "failed";
  completeMessage: string | null;
}

export type TransferWebhookParse = { kind: "outcome"; outcome: TransferWebhookOutcome } | { kind: "ignored" } | { kind: "invalid" };

/** Header carrying the webhook secret hash (v3). */
export const WEBHOOK_HASH_HEADER = "verif-hash";

/** Constant-time comparison of the presented header against the configured secret hash. */
export async function verifyWebhookHash(secretHash: string, presented: string | null): Promise<boolean> {
  if (!presented) return false;
  const digest = async (value: string): Promise<string> => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const [expectedHex, presentedHex] = await Promise.all([digest(secretHash), digest(presented)]);
  if (expectedHex.length !== presentedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i += 1) {
    diff |= expectedHex.charCodeAt(i) ^ presentedHex.charCodeAt(i);
  }
  return diff === 0;
}

/** Classify a webhook body: terminal transfer outcome, ignorable, or malformed. */
export function parseTransferWebhook(body: unknown): TransferWebhookParse {
  const parsed = V3WebhookSchema.safeParse(body);
  if (!parsed.success) return { kind: "invalid" };
  const payload = parsed.data;

  const isV3Transfer = payload.event === "transfer.completed" || payload["event.type"] === "Transfer";
  const isV4Transfer = payload.type === "transfer.disburse";
  if (!isV3Transfer && !isV4Transfer) {
    // Some other event family (charges, refunds…) — acknowledge, do nothing.
    return { kind: "ignored" };
  }
  const data = payload.data;
  if (!data || (data.id === undefined && data.reference === undefined)) {
    return { kind: "invalid" };
  }
  const providerRef = data.id === undefined ? null : `${PROVIDER_REF_PREFIX}${String(data.id)}`;
  switch ((data.status ?? "").toUpperCase()) {
    case "SUCCESSFUL":
      return {
        kind: "outcome",
        outcome: {
          reference: data.reference ?? null,
          providerRef,
          status: "completed",
          completeMessage: data.complete_message ?? null,
        },
      };
    case "FAILED":
      return {
        kind: "outcome",
        outcome: {
          reference: data.reference ?? null,
          providerRef,
          status: "failed",
          completeMessage: data.complete_message ?? null,
        },
      };
    default:
      // NEW/PENDING webhooks carry no terminal information.
      return { kind: "ignored" };
  }
}

/* ------------------------------------------------------------------------ */
/* Charge webhooks: `charge.completed` is a HINT that a checkout charge       */
/* finished — the hold layer re-verifies with the verify API before placing   */
/* a hold; the webhook itself never proves money moved. Cart/buyer            */
/* coordinates arrive in the client-attached `meta` (see the mobile client).  */
/* ------------------------------------------------------------------------ */

const ChargeMetaSchema = z
  .object({
    cartId: z.string().min(1).optional(),
    buyerId: z.string().min(1).optional(),
  })
  .passthrough();

const ChargeWebhookDataSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  tx_ref: z.string().optional(),
  status: z.string().optional(),
  meta: ChargeMetaSchema.nullable().optional(),
});

const ChargeWebhookSchema = z.object({
  event: z.string().optional(),
  "event.type": z.string().optional(),
  data: ChargeWebhookDataSchema.nullable().optional(),
});

export type ChargeWebhookParse =
  | {
      kind: "charge";
      charge: { txRef: string | null; transactionId: string | null; cartId: string | null; buyerId: string | null };
    }
  | { kind: "ignored" }
  | { kind: "invalid" };

/** Classify a webhook body as a completed-charge hint. */
export function parseChargeWebhook(body: unknown): ChargeWebhookParse {
  const parsed = ChargeWebhookSchema.safeParse(body);
  if (!parsed.success) return { kind: "invalid" };
  const payload = parsed.data;
  if (payload.event !== "charge.completed" && payload["event.type"] !== "Charge") {
    return { kind: "ignored" };
  }
  const data = payload.data;
  if (!data || (data.id === undefined && data.tx_ref === undefined)) {
    return { kind: "invalid" };
  }
  return {
    kind: "charge",
    charge: {
      txRef: data.tx_ref ?? null,
      transactionId: data.id === undefined ? null : String(data.id),
      cartId: data.meta?.cartId ?? null,
      buyerId: data.meta?.buyerId ?? null,
    },
  };
}

