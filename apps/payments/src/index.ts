import type { z } from "zod";
import {
  PaymentChargeConfirmRequestSchema,
  PaymentDispatchStatusSchema,
  PaymentHoldStatusSchema,
  PaymentRefundStatusSchema,
  PayoutAccountResolveRequestSchema,
  PayoutAccountUpsertRequestSchema,
  type PaymentDispatchStatus,
} from "@market-runs/proto";
import { RequestIdSchema } from "@market-runs/proto";
import { createDatabase } from "./db.js";
import { handleDispatchRequested } from "./consume.js";
import { handleRefundRequested } from "./refunds.js";
import {
  isTransferStatusLookup,
  resolveDispatchIntegration,
  type PaymentDispatcher,
  type TransferWebhookHooks,
} from "./dispatcher.js";
import type { ChargeGateway } from "./gateway.js";
import { DrizzleHoldStore, confirmHold, holdView, recordVerifiedHold, type HoldStore } from "./holds.js";
import { DrizzleRefundStore, refundView, type RefundStore } from "./refunds.js";
import {
  DrizzlePayoutAccountStore,
  payoutAccountView,
  type PayoutAccountRow,
  type PayoutAccountStore,
} from "./payout-accounts.js";
import { parsePaymentMessage } from "./messages.js";
import { DrizzleDispatchStore, dispatchView, type DispatchStore } from "./store.js";
import type { Env } from "./env.js";
import { paymentNotification, queuePaymentNotifications, type PaymentNotificationSink } from "./notifications.js";

/**
 * apps/payments — the payment-dispatch worker (queue consumer + ops reads +
 * provider status surface).
 *
 * The RunDO emits payment.dispatch-requested when settlement releases; this
 * worker persists every leg and executes it through the PaymentDispatcher
 * abstraction (ADR-0009 — "stub" is the dev default; the chosen PSP plugs in
 * through the dispatcher selector). Money decisions happened in the
 * settlement function (ADR-0007/0008); this worker only executes them.
 *
 * Dispatch lifecycle: pending → queued (provider accepted) → sent (in-flight
 * on the rails) → completed (settled at the destination) | failed. The
 * asynchronous transitions arrive via POST /webhooks/transfers (provider
 * push, hash-verified) or POST /dispatches/sync (polling fallback for rows
 * stuck in-flight).
 *
 * Auth posture: ops and internal DO routes remain trusted-internal. Payout
 * account management additionally requires the edge's PAYMENTS_INTERNAL_TOKEN
 * plus its resolved seller/runner identity, and enforces participant equality
 * on every save/read/revoke (explicit header-auth demo excepted). Provider
 * webhooks keep their own hash verification and never require participant auth.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Rows still sent/queued after this many minutes are polled at the provider by /dispatches/sync. */
const DEFAULT_SYNC_STALE_MINUTES = 15;
const MAX_SYNC_BATCH = 200;
/** The provider's bank directory changes rarely; cache in-isolate for 6h. */
const BANKS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let banksCache: { fetchedAt: number; items: Array<{ code: string; name: string }> } | null = null;

export interface PaymentsAppOptions {
  /**
   * Active dispatch integration label for GET /healthz (e.g. "stub" or the
   * configured vendor kind). Ops truth only — no secrets, no money semantics.
   * Defaults to "custom" for directly-constructed test apps.
   */
  dispatcherKind?: string;
  /**
   * Transfer-outcome webhook support from the resolved dispatch integration
   * (vendor-neutral hooks). Absent or `secret: null` = POST
   * /webhooks/transfers refuses with 503.
   */
  webhook?: { secret: string | null; hooks: TransferWebhookHooks };
  /**
   * Collection side: holds + refunds + the charge gateway. `gateway: null` =
   * no collection provider configured (stub dispatcher) — the hold and refund
   * routes answer 503 collection-unavailable rather than faking verification.
   */
  collections?: { holds: HoldStore; refunds: RefundStore; gateway: ChargeGateway | null };
  /** Payout-account directory: saved accounts + bank list / account resolve. */
  payouts?: { accounts: PayoutAccountStore; gateway: ChargeGateway | null };
  /**
   * Trusted edge identity for payout-account management. Deployed callers must
   * arrive through the internal-token seam; explicit header auth is demo-only.
   * Absent configuration fails closed rather than trusting client identity.
   */
  participantAuth?: { internalToken?: string; allowHeaderAuth?: boolean };
  /** Actual persisted payment transitions → durable notification queue. */
  notify?: PaymentNotificationSink;
}

export interface PaymentsWorker {
  fetch(request: Request): Promise<Response>;
  queue(batch: MessageBatch<unknown>): Promise<void>;
}

/** Build the worker around an explicit store + dispatcher (tests inject in-memory doubles). */
export function createPaymentsApp(
  store: DispatchStore,
  dispatcher: PaymentDispatcher,
  options: PaymentsAppOptions = {},
): PaymentsWorker {
  return {
    fetch: (request) => handleFetch(store, dispatcher, request, options),
    queue: (batch) => handleQueue(store, dispatcher, batch, options),
  };
}

/**
 * Request correlation (x-request-id): honor a well-formed inbound id, else
 * generate one; echo it on the response and emit one parseable log line per
 * request — { requestId, method, path, status, ms }. Cheap, no bodies.
 */
function resolveRequestId(header: string | null): string {
  return header !== null && RequestIdSchema.safeParse(header).success ? header : crypto.randomUUID();
}

async function handleFetch(
  store: DispatchStore,
  dispatcher: PaymentDispatcher,
  request: Request,
  options: PaymentsAppOptions,
): Promise<Response> {
  const started = Date.now();
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  let status = 500;
  try {
    const response = await routeRequest(store, dispatcher, request, options);
    status = response.status;
    try {
      response.headers.set("x-request-id", requestId);
    } catch {
      /* immutable headers — skip the echo, keep the log line */
    }
    return response;
  } finally {
    console.log(
      JSON.stringify({
        requestId,
        method: request.method,
        path: new URL(request.url).pathname,
        status,
        ms: Date.now() - started,
      }),
    );
  }
}

async function routeRequest(
  store: DispatchStore,
  dispatcher: PaymentDispatcher,
  request: Request,
  options: PaymentsAppOptions,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/healthz") {
    return Response.json({
      ok: true,
      service: "market-runs-payments",
      dispatcher: options.dispatcherKind ?? "custom",
    });
  }

  if (request.method === "GET" && url.pathname === "/dispatches") {
    const params = parseListParams(url);
    if (params instanceof Response) return params;
    const status = parseStatusFilter(url);
    if (status instanceof Response) return status;
    const runId = optionalFilter(url, "runId");
    const { items, total } = await store.list({ runId, status }, params);
    return Response.json({ items: items.map(dispatchView), total, ...params });
  }

  if (request.method === "POST" && /^\/dispatches\/[^/]+\/replay$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split("/")[2] ?? "");
    const row = await store.byId(id);
    if (!row) {
      return Response.json({ error: "not-found", message: `dispatch ${id} is unknown` }, { status: 404 });
    }
    if (row.status === "sent" || row.status === "queued" || row.status === "completed") {
      return Response.json(
        { error: "already-dispatched", message: `dispatch ${id} is ${row.status}; replays target failed/pending rows` },
        { status: 409 },
      );
    }
    // Re-execute through the same dispatcher abstraction — never an ad-hoc
    // transfer (ADR-0007). The row's idempotency key rides again, so a
    // provider that already accepted the transfer collapses this retry.
    const result = await dispatcher.dispatchTransfer({
      idempotencyKey: row.idempotencyKey,
      ...(row.providerReference !== null ? { providerReference: row.providerReference } : {}),
      recipient: { partyId: row.partyId, account: row.account },
      amountKobo: row.amountKobo,
      memo: row.memo,
    });
    await store.recordResult(row.id, result);
    const updated = await store.byId(row.id);
    if (result.status === "failed") {
      return Response.json(
        {
          error: "dispatch-failed",
          message: result.failureReason ?? "dispatcher reported failure",
          dispatch: updated ? dispatchView(updated) : null,
        },
        { status: 502 },
      );
    }
    return Response.json(updated ? dispatchView(updated) : null);
  }

  // Provider → worker: terminal transfer outcome. Reachable from the public
  // internet (the provider calls it), so EVERY call is verified against the
  // configured webhook secret — the worker's only authenticated route. The
  // verify/parse hooks come from the resolved integration (vendor-neutral).
  // /webhooks/charges is an alias: providers that fan event families out to
  // distinct URLs land charge.completed hints here too.
  if (
    request.method === "POST" &&
    (url.pathname === "/webhooks/transfers" || url.pathname === "/webhooks/charges")
  ) {
    const webhook = options.webhook;
    if (!webhook || !webhook.secret) {
      return Response.json(
        { error: "webhook-not-configured", message: "no webhook secret is configured on this worker" },
        { status: 503 },
      );
    }
    if (!(await webhook.hooks.verify(webhook.secret, request.headers.get(webhook.hooks.hashHeader)))) {
      return Response.json({ error: "invalid-webhook-hash", message: "webhook hash mismatch" }, { status: 401 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid-webhook-payload", message: "body is not JSON" }, { status: 400 });
    }
    const parsed = webhook.hooks.parse(body);
    if (parsed.kind === "invalid") {
      return Response.json({ error: "invalid-webhook-payload", message: "transfer payload is malformed" }, { status: 400 });
    }
    if (parsed.kind === "ignored") {
      // Not a transfer outcome — try the charge family (charge.completed).
      const chargeParsed = webhook.hooks.parseCharge?.(body);
      if (!chargeParsed || chargeParsed.kind === "ignored") {
        // Non-terminal or unknown event: acknowledge so the provider does
        // not retry it forever.
        return Response.json({ status: "ignored" });
      }
      if (chargeParsed.kind === "invalid") {
        return Response.json({ error: "invalid-webhook-payload", message: "charge payload is malformed" }, { status: 400 });
      }
      return handleChargeWebhook(options, chargeParsed.charge);
    }
    const { outcome } = parsed;
    // Match by the provider alias first (the transfer reference we sent),
    // then by the legacy full idempotency key (rows created before the alias
    // column), then by the providerRef.
    let row = outcome.reference !== null ? await store.byProviderReference(outcome.reference) : null;
    if (!row && outcome.reference !== null) {
      row = await store.byIdempotencyKey(outcome.reference);
    }
    if (!row && outcome.providerRef !== null) {
      row = await store.byProviderRef(outcome.providerRef);
    }
    if (!row) {
      // Unknown to us (e.g. a transfer from another system on the same
      // provider account): acknowledge, don't retry-storm.
      console.error(JSON.stringify({ event: "payment.webhook_unmatched", reference: outcome.reference }));
      return Response.json({ status: "unmatched" });
    }
    await store.recordStatus(row.id, {
      status: outcome.status,
      failureReason: outcome.status === "failed" ? outcome.completeMessage ?? "provider reported failure" : null,
    });
    if (options.notify && row.account !== "platform") {
      await options.notify(paymentNotification({
        sourceEventId: `payment.dispatch-status:${row.id}:${outcome.status}`,
        sourceEventType: "payment.dispatch-updated",
        recipientId: row.partyId,
        title: outcome.status === "failed" ? "Dispatch failed" : "Dispatch completed",
        body: `Your ${row.account} dispatch is ${outcome.status}.`,
        runId: row.runId,
        deepLink: "/notifications",
        status: outcome.status,
      }));
    }
    console.error(
      JSON.stringify({
        event: "payment.webhook_applied",
        dispatchId: row.id,
        status: outcome.status,
      }),
    );
    const updated = await store.byId(row.id);
    return Response.json({ status: "applied", dispatch: updated ? dispatchView(updated) : null });
  }

  // Polling fallback: rows stuck in sent/queued longer than the stale window
  // are re-queried at the provider and converged to completed/failed.
  if (request.method === "POST" && url.pathname === "/dispatches/sync") {
    if (!isTransferStatusLookup(dispatcher)) {
      return Response.json(
        { error: "sync-unsupported", message: "the configured dispatcher cannot poll transfer status" },
        { status: 501 },
      );
    }
    let staleMinutes = DEFAULT_SYNC_STALE_MINUTES;
    let limit = DEFAULT_LIMIT;
    const body = await readOptionalJson(request);
    if (body && typeof body === "object") {
      const raw = body as Record<string, unknown>;
      if (typeof raw.staleMinutes === "number" && Number.isInteger(raw.staleMinutes) && raw.staleMinutes >= 1) {
        staleMinutes = raw.staleMinutes;
      }
      if (typeof raw.limit === "number" && Number.isInteger(raw.limit) && raw.limit >= 1) {
        limit = Math.min(raw.limit, MAX_SYNC_BATCH);
      }
    }
    const cutoff = new Date(Date.now() - staleMinutes * 60_000);
    const rows = await store.listStale(["sent", "queued"], cutoff, limit);
    let updated = 0;
    let unchanged = 0;
    let unmatched = 0;
    for (const row of rows) {
      if (!row.providerRef) {
        unmatched += 1;
        continue;
      }
      const outcome = await dispatcher.fetchTransferStatus(row.providerRef);
      if (!outcome) {
        unmatched += 1;
        continue;
      }
      if (outcome.status === "completed" || outcome.status === "failed") {
        await store.recordStatus(row.id, {
          status: outcome.status,
          failureReason: outcome.status === "failed" ? outcome.failureReason ?? "provider reported failure" : null,
        });
        if (options.notify && row.account !== "platform") {
          await options.notify(paymentNotification({
            sourceEventId: `payment.dispatch-status:${row.id}:${outcome.status}`,
            sourceEventType: "payment.dispatch-updated",
            recipientId: row.partyId,
            title: outcome.status === "failed" ? "Dispatch failed" : "Dispatch completed",
            body: `Your ${row.account} dispatch is ${outcome.status}.`,
            runId: row.runId,
            deepLink: "/notifications",
            status: outcome.status,
          }));
        }
        updated += 1;
      } else {
        unchanged += 1;
      }
    }
    console.error(
      JSON.stringify({ event: "payment.sync", scanned: rows.length, updated, unchanged, unmatched, staleMinutes }),
    );
    return Response.json({ scanned: rows.length, updated, unchanged, unmatched, staleMinutes });
  }

  /* ---------------------------------------------------------------------- */
  /* Collection: charge confirmation + holds (ADR-0023/0024 follow-up).     */
  /* ---------------------------------------------------------------------- */

  // Buyer client (via the edge in production posture): confirm a completed
  // checkout charge and place the hold. The provider verify API is the ONLY
  // truth — client amounts are a cross-check, never trusted.
  if (request.method === "POST" && url.pathname === "/payments/charges/confirm") {
    const collections = options.collections;
    if (!collections || !collections.gateway) {
      return Response.json(
        { error: "collection-unavailable", message: "no collection provider is configured on this worker" },
        { status: 503 },
      );
    }
    const body = await readOptionalJson(request);
    const parsed = PaymentChargeConfirmRequestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "invalid-request", message: "charge confirmation failed validation", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const result = await confirmHold(collections.holds, collections.gateway, parsed.data);
    if (result.kind === "error") {
      return Response.json({ error: result.error, message: result.message }, { status: result.status });
    }
    if (!result.replayed && options.notify) {
      await options.notify(paymentNotification({
        sourceEventId: `payment.hold-placed:${result.hold.id}:${result.hold.status}`,
        sourceEventType: "payment.hold-placed",
        recipientId: result.hold.buyerId,
        title: "Payment hold confirmed",
        body: "Your payment was verified and held for checkout.",
        cartId: result.hold.cartId,
        ...(result.hold.runId ? { runId: result.hold.runId } : {}),
        status: result.hold.status,
      }));
    }
    console.error(
      JSON.stringify({
        event: "payment.hold_placed",
        holdId: result.hold.id,
        cartId: result.hold.cartId,
        amountKobo: result.hold.amountKobo,
        replayed: result.replayed,
      }),
    );
    return Response.json({
      holdId: result.hold.id,
      txRef: result.hold.txRef,
      amountKobo: result.hold.amountKobo,
      status: result.hold.status,
    });
  }

  // Ops read: holds list (admin-list shaped; filters buyerId/runId/status).
  if (request.method === "GET" && url.pathname === "/payments/holds") {
    if (!options.collections) return collectionsUnavailable();
    const params = parseListParams(url);
    if (params instanceof Response) return params;
    const status = parseEnumFilter(url, "status", PaymentHoldStatusSchema);
    if (status instanceof Response) return status;
    const { items, total } = await options.collections.holds.list(
      { buyerId: optionalFilter(url, "buyerId"), runId: optionalFilter(url, "runId"), status },
      params,
    );
    return Response.json({ items: items.map(holdView), total, ...params });
  }

  // Checkout gating read (edge CartDO): fetch a hold by its txRef.
  if (request.method === "GET" && /^\/payments\/holds\/[^/]+$/.test(url.pathname)) {
    if (!options.collections) return collectionsUnavailable();
    const txRef = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const hold = await options.collections.holds.byTxRef(txRef);
    if (!hold) {
      return Response.json({ error: "not-found", message: `no hold for txRef ${txRef}` }, { status: 404 });
    }
    return Response.json(holdView(hold));
  }

  // Checkout gating write (edge CartDO): bind the hold to its run.
  // Idempotent on the same runId; a different runId is a conflict (one hold,
  // one run).
  if (request.method === "POST" && /^\/payments\/holds\/[^/]+\/bind$/.test(url.pathname)) {
    if (!options.collections) return collectionsUnavailable();
    const txRef = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const hold = await options.collections.holds.byTxRef(txRef);
    if (!hold) {
      return Response.json({ error: "not-found", message: `no hold for txRef ${txRef}` }, { status: 404 });
    }
    const body = await readOptionalJson(request);
    const runId =
      typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).runId === "string"
        ? ((body as Record<string, unknown>).runId as string)
        : null;
    if (!runId) {
      return Response.json({ error: "invalid-request", message: "runId is required" }, { status: 400 });
    }
    const bound = await options.collections.holds.bindRun(hold.id, runId);
    if (bound === "conflict") {
      return Response.json(
        { error: "hold-conflict", message: `hold ${hold.id} is already bound to run ${hold.runId}` },
        { status: 409 },
      );
    }
    const updated = await options.collections.holds.byId(hold.id);
    return Response.json({ status: bound, hold: updated ? holdView(updated) : null });
  }

  // Ops read: refunds list (admin-list shaped; filters holdId/settlementRecordId/status).
  if (request.method === "GET" && url.pathname === "/payments/refunds") {
    if (!options.collections) return collectionsUnavailable();
    const params = parseListParams(url);
    if (params instanceof Response) return params;
    const status = parseEnumFilter(url, "status", PaymentRefundStatusSchema);
    if (status instanceof Response) return status;
    const { items, total } = await options.collections.refunds.list(
      {
        holdId: optionalFilter(url, "holdId"),
        settlementRecordId: optionalFilter(url, "settlementRecordId"),
        status,
      },
      params,
    );
    return Response.json({ items: items.map(refundView), total, ...params });
  }

  /* ---------------------------------------------------------------------- */
  /* Payout accounts: bank directory, account resolution, saved accounts.   */
  /* ---------------------------------------------------------------------- */

  // The provider's NG bank directory, cached in-isolate (TTL above).
  if (request.method === "GET" && url.pathname === "/payments/banks") {
    const gateway = options.payouts?.gateway ?? options.collections?.gateway ?? null;
    if (!gateway) return collectionsUnavailable();
    if (banksCache && Date.now() - banksCache.fetchedAt < BANKS_CACHE_TTL_MS) {
      return Response.json({ items: banksCache.items, cachedAt: banksCache.fetchedAt });
    }
    try {
      const items = await gateway.listBanks();
      banksCache = { fetchedAt: Date.now(), items };
      return Response.json({ items, cachedAt: banksCache.fetchedAt });
    } catch (error) {
      return Response.json(
        { error: "bank-directory-unavailable", message: String(error) },
        { status: 502 },
      );
    }
  }

  // Resolve an account number to its account name (never stores anything).
  if (request.method === "POST" && url.pathname === "/payments/payout-accounts/resolve") {
    const authorization = requirePayoutParticipant(request, options);
    if (authorization instanceof Response) return authorization;
    const gateway = options.payouts?.gateway ?? null;
    if (!gateway) return collectionsUnavailable();
    const parsed = PayoutAccountResolveRequestSchema.safeParse(await readOptionalJson(request));
    if (!parsed.success) {
      return Response.json(
        { error: "invalid-request", message: "bankCode and accountNumber are required", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const resolved = await gateway.resolveAccount(parsed.data.bankCode, parsed.data.accountNumber);
    if (!resolved) {
      return Response.json(
        { error: "account-unresolvable", message: "the provider could not resolve this account" },
        { status: 422 },
      );
    }
    return Response.json({ ...parsed.data, accountName: resolved.accountName });
  }

  // Save a payout account — ALWAYS resolved with the provider first; an
  // unresolved account is never stored (a wrong account misdirects money).
  if (request.method === "POST" && url.pathname === "/payments/payout-accounts") {
    const participant = requirePayoutParticipant(request, options);
    if (participant instanceof Response) return participant;
    const payouts = options.payouts;
    if (!payouts || !payouts.gateway) return collectionsUnavailable();
    const parsed = PayoutAccountUpsertRequestSchema.safeParse(await readOptionalJson(request));
    if (!parsed.success) {
      return Response.json(
        { error: "invalid-request", message: "participantId, bankCode and accountNumber are required", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const sameParticipant = requireSameParticipant(participant.id, parsed.data.participantId);
    if (sameParticipant) return sameParticipant;
    const resolved = await payouts.gateway.resolveAccount(parsed.data.bankCode, parsed.data.accountNumber);
    if (!resolved) {
      return Response.json(
        { error: "account-unresolvable", message: "the provider could not resolve this account" },
        { status: 422 },
      );
    }
    const row: PayoutAccountRow = {
      participantId: participant.id,
      bankCode: parsed.data.bankCode,
      accountNumber: parsed.data.accountNumber,
      accountName: resolved.accountName,
      verifiedAt: new Date(),
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await payouts.accounts.upsert(row);
    console.error(JSON.stringify({ event: "payment.payout_account_saved", participantId: row.participantId }));
    return Response.json(payoutAccountView(row));
  }

  // Read / revoke only the authenticated participant's own payout account.
  const payoutAccountMatch = /^\/payments\/payout-accounts\/([^/]+)$/.exec(url.pathname);
  if (payoutAccountMatch && (request.method === "GET" || request.method === "DELETE")) {
    const participant = requirePayoutParticipant(request, options);
    if (participant instanceof Response) return participant;
    if (!options.payouts) return collectionsUnavailable();
    const participantId = decodeURIComponent(payoutAccountMatch[1] ?? "");
    const sameParticipant = requireSameParticipant(participant.id, participantId);
    if (sameParticipant) return sameParticipant;
    const row = await options.payouts.accounts.byParticipantId(participantId);
    if (!row) {
      return Response.json({ error: "not-found", message: `no active payout account for ${participantId}` }, { status: 404 });
    }
    if (request.method === "DELETE") {
      await options.payouts.accounts.revoke(participantId);
      return Response.json(payoutAccountView({ ...row, revokedAt: new Date() }));
    }
    return Response.json(payoutAccountView(row));
  }

  return Response.json({ error: "not-found", message: `no route: ${request.method} ${url.pathname}` }, { status: 404 });
}

function collectionsUnavailable(): Response {
  return Response.json(
    { error: "collection-unavailable", message: "no collection provider is configured on this worker" },
    { status: 503 },
  );
}

type PayoutParticipant = { id: string; role: "seller" | "runner" };

/** Only the edge's authenticated internal seam can assert participant identity. */
function requirePayoutParticipant(request: Request, options: PaymentsAppOptions): PayoutParticipant | Response {
  const auth = options.participantAuth;
  if (auth?.internalToken) {
    if (request.headers.get("x-payments-internal") !== auth.internalToken) {
      return Response.json({ error: "unauthorized", message: "valid internal authentication is required" }, { status: 401 });
    }
  } else if (auth?.allowHeaderAuth !== true) {
    return Response.json(
      { error: "payments-auth-unconfigured", message: "PAYMENTS_INTERNAL_TOKEN is required" },
      { status: 503 },
    );
  }

  const id = request.headers.get("x-participant-id");
  const role = request.headers.get("x-participant-role");
  if (!id || !role) {
    return Response.json({ error: "unauthorized", message: "resolved participant identity is required" }, { status: 401 });
  }
  if (role !== "seller" && role !== "runner") {
    return Response.json({ error: "forbidden", message: "seller or runner role is required" }, { status: 403 });
  }
  return { id, role };
}

function requireSameParticipant(resolvedId: string, requestedId: string): Response | null {
  if (resolvedId === requestedId) return null;
  return Response.json({ error: "forbidden", message: "cannot manage another participant's payout account" }, { status: 403 });
}

/**
 * A charge.completed webhook is a HINT: re-verify with the provider, then
 * place the hold when the client attached cart/buyer coordinates as charge
 * meta. Anything else is acknowledged (non-2xx would make the provider retry
 * forever) and logged — the confirm endpoint remains the authoritative path.
 */
async function handleChargeWebhook(
  options: PaymentsAppOptions,
  charge: { txRef: string | null; transactionId: string | null; cartId: string | null; buyerId: string | null },
): Promise<Response> {
  const collections = options.collections;
  if (!collections || !collections.gateway) {
    console.error(JSON.stringify({ event: "payment.charge_webhook_unconfigured", txRef: charge.txRef }));
    return Response.json({ status: "ignored" });
  }
  const verification = await collections.gateway.verifyCharge({
    ...(charge.txRef !== null ? { txRef: charge.txRef } : {}),
    ...(charge.transactionId !== null ? { transactionId: charge.transactionId } : {}),
  });
  if (!verification) {
    console.error(JSON.stringify({ event: "payment.charge_webhook_unmatched", txRef: charge.txRef }));
    return Response.json({ status: "unmatched" });
  }
  if (verification.status !== "successful") {
    console.error(
      JSON.stringify({ event: "payment.charge_webhook_unsuccessful", txRef: charge.txRef, status: verification.status }),
    );
    return Response.json({ status: "ignored" });
  }
  if (!charge.cartId || !charge.buyerId) {
    // No cart/buyer meta: the confirm endpoint (which carries them) is the
    // authoritative path for this charge.
    console.error(JSON.stringify({ event: "payment.charge_webhook_no_meta", txRef: charge.txRef }));
    return Response.json({ status: "ignored" });
  }
  const result = await recordVerifiedHold(collections.holds, verification, {
    buyerId: charge.buyerId,
    cartId: charge.cartId,
  });
  if (result.kind === "error") {
    console.error(
      JSON.stringify({ event: "payment.charge_webhook_rejected", txRef: charge.txRef, error: result.error }),
    );
    return Response.json({ status: "ignored" });
  }
  if (!result.replayed && options.notify) {
    await options.notify(paymentNotification({
      sourceEventId: `payment.hold-placed:${result.hold.id}:${result.hold.status}`,
      sourceEventType: "payment.hold-placed",
      recipientId: result.hold.buyerId,
      title: "Payment hold confirmed",
      body: "Your payment was verified and held for checkout.",
      cartId: result.hold.cartId,
      status: result.hold.status,
    }));
  }
  console.error(
    JSON.stringify({ event: "payment.hold_placed", holdId: result.hold.id, source: "webhook", replayed: result.replayed }),
  );
  return Response.json({ status: "applied", holdId: result.hold.id });
}

async function readOptionalJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function handleQueue(
  store: DispatchStore,
  dispatcher: PaymentDispatcher,
  batch: MessageBatch<unknown>,
  options: PaymentsAppOptions = {},
): Promise<void> {
  for (const message of batch.messages) {
    const result = parsePaymentMessage(message.body);
    if (!result.success) {
      // Poison pill: schema-invalid bodies will never parse; ack and log
      // rather than burning retries into the DLQ.
      console.error(JSON.stringify({ event: "payment.dead_letter", messageId: message.id, issues: result.error.issues }));
      message.ack();
      continue;
    }
    try {
      if (result.data.type === "payment.dispatch-requested") {
        await handleDispatchRequested(store, dispatcher, message, result.data, options.collections?.holds, options.notify);
      } else {
        // payment.refund-requested — the refund rail against the run's hold.
        if (!options.collections) {
          throw new Error("payment.refund-requested received but collection stores are not configured");
        }
        await handleRefundRequested(
          options.collections.holds,
          options.collections.refunds,
          options.collections.gateway,
          message,
          result.data,
          options.notify,
        );
      }
    } catch (error) {
      // Unexpected (store/infra) failure: retry the message — acked legs are
      // idempotent, so a redelivery only redoes work that never persisted.
      console.error(
        JSON.stringify({
          event: "payment.dispatch_error",
          messageId: message.id,
          ...(result.data.requestId !== undefined ? { requestId: result.data.requestId } : {}),
          error: String(error),
        }),
      );
      message.retry({ delaySeconds: 30 });
      continue;
    }
    // One line per applied queue message; requestId joins the persisted rows
    // to the originating request's trace when the emitter carried one.
    console.log(
      JSON.stringify({
        event: "payment.message_applied",
        type: result.data.type,
        messageId: message.id,
        ...(result.data.requestId !== undefined ? { requestId: result.data.requestId } : {}),
      }),
    );
  }
}

function parseListParams(url: URL): { limit: number; offset: number } | Response {
  const limitRaw = url.searchParams.get("limit");
  const offsetRaw = url.searchParams.get("offset");
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return Response.json(
      { error: "invalid-query", message: `limit must be an integer between 1 and ${MAX_LIMIT}` },
      { status: 400 },
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return Response.json({ error: "invalid-query", message: "offset must be a non-negative integer" }, { status: 400 });
  }
  return { limit, offset };
}

function parseStatusFilter(url: URL): PaymentDispatchStatus | null | Response {
  const raw = url.searchParams.get("status");
  if (raw === null || raw === "") return null;
  const parsed = PaymentDispatchStatusSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid-query", message: "status must be pending, sent, queued, failed, or completed" },
      { status: 400 },
    );
  }
  return parsed.data;
}

/** Parse an optional enum query filter against a zod enum schema. */
function parseEnumFilter<S extends z.ZodTypeAny>(url: URL, name: string, schema: S): z.infer<S> | null | Response {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return null;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "invalid-query", message: `invalid ${name} filter` }, { status: 400 });
  }
  return parsed.data as z.infer<S>;
}

function optionalFilter(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  return value === null || value === "" ? null : value;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { db, client } = createDatabase(env);
    try {
      const holds = new DrizzleHoldStore(db);
      const refunds = new DrizzleRefundStore(db);
      const payoutAccounts = new DrizzlePayoutAccountStore(db);
      const integration = resolveDispatchIntegration(env, { payoutAccounts });
      return await handleFetch(new DrizzleDispatchStore(db), integration.dispatcher, request, {
        dispatcherKind: env.PAYMENT_DISPATCHER ?? "stub",
        ...(integration.webhook !== undefined ? { webhook: integration.webhook } : {}),
        collections: { holds, refunds, gateway: integration.gateway ?? null },
        payouts: { accounts: payoutAccounts, gateway: integration.gateway ?? null },
        participantAuth: {
          ...(env.PAYMENTS_INTERNAL_TOKEN !== undefined ? { internalToken: env.PAYMENTS_INTERNAL_TOKEN } : {}),
          allowHeaderAuth: env.ALLOW_HEADER_AUTH === "true",
        },
        notify: queuePaymentNotifications(env.NOTIFICATION_QUEUE),
      });
    } finally {
      await client.end();
    }
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const { db, client } = createDatabase(env);
    try {
      const integration = resolveDispatchIntegration(env, { payoutAccounts: new DrizzlePayoutAccountStore(db) });
      await handleQueue(new DrizzleDispatchStore(db), integration.dispatcher, batch, {
        collections: {
          holds: new DrizzleHoldStore(db),
          refunds: new DrizzleRefundStore(db),
          gateway: integration.gateway ?? null,
        },
        notify: queuePaymentNotifications(env.NOTIFICATION_QUEUE),
      });
    } finally {
      await client.end();
    }
  },
};
