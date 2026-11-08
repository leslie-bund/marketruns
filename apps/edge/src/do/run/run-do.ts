import { DurableObject } from "cloudflare:workers";
import { TelemetryReporter } from "../telemetry.js";
import { DISPUTE_WINDOW_MS, HANDOFF_AUTO_CONFIRM_MS, settle, validateLocationWithinFence } from "@market-runs/domain";
import type { GeoFence, LocationFix, SettlementInput } from "@market-runs/domain";
import { buildSettlementInput } from "./settlement.js";
import {
  DELIVERY_CODE_MAX_ATTEMPTS,
  DELIVERY_CODE_TTL_MS,
  hashDeliveryCode,
  issueDeliveryCode,
  pickupChallenge,
  secretsEqual,
} from "./delivery-security.js";
import type { InternalHandoff, RunState } from "./state.js";
import type {
  HandoffChallengeScanned,
  HandoffPhotoCaptured,
  OpsRunDetail,
  RunnerLocationUpdated,
  Run,
  RunHandoff,
  ServerEvent,
} from "@market-runs/proto";
import type { Env } from "../../config/env.js";
import {
  acceptHibernatedWebSocket,
  broadcast,
  conflict,
  expectCommand,
  handleWebSocketClose,
  handleWebSocketError,
  handleWebSocketMessage,
  internalErrorGuard,
  isWebSocketUpgrade,
  jsonResponse,
  notFound,
  parseClientCommand,
  parseInternal,
  refusal,
  serializeEvent,
} from "../runtime/index.js";
import { STATE_KEY } from "../state.js";
import type {
  ClaimRunRequest,
  DisputeRunRequest,
  HandoffRefRequest,
  InitiateHandoffRequest,
  OpsSettleRequest,
  SeedRunRequest,
} from "../schemas.js";
import {
  ClaimRunRequestSchema,
  DisputeRunRequestSchema,
  HandoffRefRequestSchema,
  InitiateHandoffRequestSchema,
  MarketConfigSchema,
  OpsSettleRequestSchema,
  SeedRunRequestSchema,
} from "../schemas.js";

/**
 * Per run: stops, handoffs, location, and the settlement trigger. Holds live
 * trip state only; at close the settlement and the final snapshot leave
 * through the archive queue, then DO storage is deleted (ADR-0010).
 */
export class RunDO extends DurableObject<Env> {
  private state: RunState = { legs: [], handoffs: [], settlementReleased: false, disputed: false };
  private telemetry: TelemetryReporter;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.telemetry = new TelemetryReporter(ctx, "RunDO");
  }

  private now(): number {
    return Date.now() + (this.state.timeOffsetMs ?? 0);
  }

  async fetch(request: Request): Promise<Response> {
    // Doctrine: load state from storage at the start of every fetch.
    this.state =
      (await this.ctx.storage.get<RunState>(STATE_KEY)) ?? { legs: [], handoffs: [], settlementReleased: false, disputed: false };
    const url = new URL(request.url);
    const path = url.pathname.endsWith("/") && url.pathname.length > 1 ? url.pathname.slice(0, -1) : url.pathname;

    const objectName = this.ctx.id.name ?? "unknown";
    this.telemetry.beat(this.env, objectName, this.state.run?.market);
    if (isWebSocketUpgrade(request)) return acceptHibernatedWebSocket(this.ctx, request);
    if (request.method === "GET" && path === "/ops/telemetry") return this.telemetry.snapshot(this.env, objectName, this.state.run?.market);

    if (request.method === "POST" && path === "/seed") {
      const parsed = await parseInternal(request, SeedRunRequestSchema);
      if (!parsed.ok) return parsed.response;
      return internalErrorGuard(() => this.seed(parsed.data, request.headers.get("x-request-id") ?? undefined));
    }
    const enforceLocation = request.headers.get("x-resolved-participant-source") === "session";
    if (request.method === "POST" && path === "/claim") {
      const parsed = await parseInternal(request, ClaimRunRequestSchema);
      if (!parsed.ok) return parsed.response;
      return internalErrorGuard(() => this.claim(parsed.data, enforceLocation));
    }
    if (request.method === "POST" && enforceLocation &&
        (path.startsWith("/handoff/") || path === "/location" || path === "/delivery/final")) {
      const participantId = request.headers.get("x-resolved-participant-id");
      const role = request.headers.get("x-resolved-participant-role");
      if (path === "/handoff/confirm" && role === "buyer" && this.state.buyerId === participantId) {
        // The buyer may explicitly confirm their own typed delivery handoff.
      } else if (role !== "runner" || this.state.runnerId !== participantId) {
        return conflict("only the assigned runner or receiving buyer may mutate this handoff");
      }
    }
    if (request.method === "POST" && path === "/handoff/initiate") {
      const parsed = await parseInternal(request, InitiateHandoffRequestSchema);
      if (!parsed.ok) return parsed.response;
      return internalErrorGuard(() => this.initiate(parsed.data));
    }
    if (request.method === "POST" && path === "/handoff/scan") {
      const parsed = await parseClientCommand(request);
      const command = expectCommand(parsed, "handoff.challenge-scanned");
      if (command instanceof Response) return command;
      return internalErrorGuard(() => this.scan(command, enforceLocation));
    }
    if (request.method === "POST" && path === "/handoff/confirm") {
      const parsed = await parseInternal(request, HandoffRefRequestSchema);
      if (!parsed.ok) return parsed.response;
      return internalErrorGuard(() => this.confirm(parsed.data, enforceLocation));
    }
    if (request.method === "POST" && path === "/handoff/photo") {
      const parsed = await parseClientCommand(request);
      const command = expectCommand(parsed, "handoff.photo-captured");
      if (command instanceof Response) return command;
      return internalErrorGuard(() => this.photo(command, enforceLocation));
    }
    if (request.method === "POST" && path === "/location") {
      const parsed = await parseClientCommand(request);
      const command = expectCommand(parsed, "run.location-updated");
      if (command instanceof Response) return command;
      return internalErrorGuard(() => this.location(command));
    }
    if (request.method === "POST" && path === "/delivery/final") {
      return internalErrorGuard(() => this.finalDelivery(enforceLocation));
    }
    if (request.method === "POST" && path === "/dispute") {
      const parsed = await parseInternal(request, DisputeRunRequestSchema);
      if (!parsed.ok) return parsed.response;
      return internalErrorGuard(() => this.dispute(parsed.data));
    }
    if (request.method === "POST" && path === "/ops/settle") {
      const parsed = await parseInternal(request, OpsSettleRequestSchema);
      if (!parsed.ok) return parsed.response;
      return internalErrorGuard(() => this.opsSettle(parsed.data));
    }
    if (request.method === "GET" && path === "/delivery-code") {
      return internalErrorGuard(() => this.deliveryCode());
    }
    if (request.method === "POST" && path === "/delivery-code/rotate") {
      return internalErrorGuard(() => this.rotateDeliveryCode());
    }
    if (request.method === "GET" && path === "/handoff/challenge") {
      const handoffId = url.searchParams.get("handoffId") ?? "";
      return internalErrorGuard(() => this.handoffChallenge(handoffId));
    }
    if (request.method === "GET" && path === "/") {
      const run = this.state.run;
      if (!run) return notFound("run is unknown or retired");
      const event: ServerEvent = { type: "run.updated", run: this.wireRun() };
      return jsonResponse(event);
    }
    /**
     * Ops console run detail (GET /ops/api/runs/:runId): the wire run PLUS
     * the live dispute block — reason, raiser, and the server-merged evidence
     * refs. Ops-only by construction (ADR-0019): participants never enumerate
     * dispute evidence refs, so this projection has its own route and never
     * rides the broadcast wire. This is the evidence review that precedes an
     * ops settle.
     */
    if (request.method === "GET" && path === "/ops") {
      if (!this.state.run) return notFound("run is unknown or retired");
      const detail: OpsRunDetail = {
        run: this.wireRun(),
        dispute: this.state.disputed
          ? {
              reason: this.state.disputeReason ?? "disputed",
              raisedByParticipantId: this.state.disputeRaisedByParticipantId ?? null,
              evidenceRefs: this.state.disputeEvidenceRefs ?? [],
            }
          : null,
      };
      return jsonResponse(detail);
    }
    return notFound(`RunDO route not found: ${request.method} ${path}`);
  }

  private requireRun(): Run | Response {
    const run = this.state.run;
    if (!run) return notFound("run is unknown or retired");
    return run;
  }

  /**
   * The wire run: the live Run projection plus the durable dispute state and
   * the final-delivery stamp (additive optional fields on RunSchema — older
   * clients ignore them). Dispute state lives on RunState, not inside the
   * stored run, so it is merged here at every emission point.
   */
  private wireRun(): Run {
    const run = this.state.run;
    if (!run) throw new Error("wireRun called before seed");
    return {
      ...run,
      ...(this.state.buyerId ? { buyerId: this.state.buyerId } : {}),
      ...(this.state.runnerId ? { runnerId: this.state.runnerId } : {}),
      ...(this.state.sellerParticipantIds?.length ? { sellerParticipantIds: this.state.sellerParticipantIds } : {}),
      disputed: this.state.disputed,
      disputeRaisedByParticipantId: this.state.disputeRaisedByParticipantId ?? null,
      finalDeliveryAt: this.state.finalDeliveryAt ?? null,
    };
  }

  /** Trusted recipient attribution attached to handoff events at the source. */
  private participantAttribution(): Pick<Run, "buyerId" | "runnerId" | "sellerParticipantIds"> {
    return {
      ...(this.state.buyerId ? { buyerId: this.state.buyerId } : {}),
      ...(this.state.runnerId ? { runnerId: this.state.runnerId } : {}),
      ...(this.state.sellerParticipantIds?.length ? { sellerParticipantIds: this.state.sellerParticipantIds } : {}),
    };
  }

  /** CartDO seeds the run at checkout: stops, settlement legs, coefficients. */
  private async seed(data: SeedRunRequest, requestId?: string): Promise<Response> {
    if (this.state.run) {
      const event: ServerEvent = { type: "run.updated", run: this.wireRun() };
      const issued = await issueDeliveryCode(this.env, this.state.run.id, this.state.deliveryCodeIssuedAt ?? this.state.startedAt ?? this.now());
      return jsonResponse({ ...event, deliveryCode: issued.code, deliveryCodeExpiresAt: this.state.deliveryCodeExpiresAt });
    }
    const issuedAt = this.now();
    const issued = await issueDeliveryCode(this.env, data.run.id, issuedAt);
    const run: Run = {
      id: data.run.id,
      market: data.run.market,
      status: data.run.status,
      floorRateKobo: data.run.floorRateKobo,
      delivery: data.run.delivery,
      receiver: data.run.receiver,
      ...(data.run.delegatedByParticipantId ? { delegatedByParticipantId: data.run.delegatedByParticipantId } : {}),
      stops: data.run.stops,
      handoffs: [],
      ...(data.run.route !== undefined ? { route: data.run.route } : {}),
    };
    this.state.run = run;
    this.state.legs = data.legs;
    this.state.settlementConfig = data.settlement;
    this.state.buyerId = data.buyerId;
    this.state.runnerId = data.runnerId;
    this.state.startedAt = issuedAt;
    this.state.deliveryCodeIssuedAt = issuedAt;
    this.state.deliveryCodeExpiresAt = issuedAt + DELIVERY_CODE_TTL_MS;
    this.state.deliveryCodeHash = issued.hash;
    this.state.storeIds = [...new Set(run.stops.map((stop) => stop.storeId ?? stop.sellerName))];
    if (data.sellerParticipantIds !== undefined) this.state.sellerParticipantIds = data.sellerParticipantIds;
    if (requestId !== undefined) this.state.requestId = requestId;
    await this.ctx.storage.put(STATE_KEY, this.state);
    const event: ServerEvent = { type: "run.updated", run: this.wireRun() };
    broadcast(this.ctx, this.env, event);
    return jsonResponse({ ...event, deliveryCode: issued.code, deliveryCodeExpiresAt: this.state.deliveryCodeExpiresAt });
  }

  /** Single-threaded DO transition: exactly one pool runner can claim an unassigned run. */
  private async claim(data: ClaimRunRequest, enforceLocation: boolean): Promise<Response> {
    const run = this.requireRun();
    if (run instanceof Response) return run;
    if (this.state.runnerId && this.state.runnerId !== data.participantId) return conflict("run was already claimed by another runner");
    if (!this.state.runnerId && run.status !== "unassigned") return conflict(`run is ${run.status} and cannot be claimed`);
    if (enforceLocation && !data.location) return refusal("location-required", "Share a current in-perimeter GPS fix before claiming this run.");
    this.state.runnerId = data.participantId;
    this.state.locationRequired = enforceLocation;
    if (data.location) run.location = data.location;
    run.status = "assigned";
    await this.ctx.storage.put(STATE_KEY, this.state);
    const started: ServerEvent = {
      type: "run.started",
      runId: run.id,
      market: run.market,
      status: run.status,
      runnerId: data.participantId,
      buyerId: this.state.buyerId ?? "buyer:anonymous",
      startedAt: this.state.startedAt ?? this.now(),
      stopCount: run.stops.length,
      storeIds: this.state.storeIds ?? [],
      ...(this.state.requestId ? { requestId: this.state.requestId } : {}),
    };
    await this.env.ARCHIVE_QUEUE.send(serializeEvent(started));
    const event: ServerEvent = { type: "run.updated", run: this.wireRun() };
    broadcast(this.ctx, event);
    return jsonResponse({ ...event, runnerId: data.participantId });
  }

  /**
   * A handoff opens: the 3-min auto-confirm clock starts (buyer silence =
   * consent) — but the confirm, manual or automatic, lands only once photo
   * evidence is attached (photo-required, ADR-0019 as amended).
   */
  private async initiate(data: InitiateHandoffRequest): Promise<Response> {
    const run = this.requireRun();
    if (run instanceof Response) return run;
    if (run.status === "closed" || run.status === "aborted" || run.status === "delivered") {
      return conflict(`run is ${run.status}; no new handoffs`);
    }
    if (this.state.handoffs.some((handoff) => handoff.id === data.handoffId)) {
      return conflict(`handoff ${data.handoffId} already exists`);
    }
    if (data.handoffType === "pickup") {
      if (!run.stops.some((stop) => stop.exchangePoint === data.exchangePointId && stop.status !== "completed")) {
        return conflict("pickup handoff must address an incomplete seller stop");
      }
    } else {
      const destination = run.delivery.kind === "plus-code" ? run.delivery.plusCode : run.delivery.name;
      if (data.exchangePointId !== destination) return conflict("delivery handoff must address the run destination");
      if (!run.stops.every((stop) => stop.status === "completed")) return conflict("every seller stop must complete before delivery");
      if (this.state.handoffs.some((handoff) => handoff.type === "delivery")) return conflict("this run already has a delivery handoff");
    }
    const now = this.now();
    this.state.handoffs.push({
      id: data.handoffId,
      type: data.handoffType,
      exchangePointId: data.exchangePointId,
      counterparty: data.counterparty,
      status: "pending",
      requestedAt: now,
    });
    if (data.handoffType === "pickup" && run.status === "assigned") run.status = "collecting";
    run.handoffs = this.wireHandoffs();
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.scheduleAlarm();

    const event: ServerEvent = {
      type: "handoff.initiated",
      handoffId: data.handoffId,
      handoffType: data.handoffType,
      runId: run.id,
      exchangePointId: data.exchangePointId,
      counterparty: data.counterparty,
      requestedAt: now,
      deadline: now + HANDOFF_AUTO_CONFIRM_MS,
      ...this.participantAttribution(),
    };
    broadcast(this.ctx, this.env, event);
    broadcast(this.ctx, this.env, { type: "run.updated", run: this.wireRun() });
    return jsonResponse(event);
  }

  /**
   * Narrow geofence seam for the handoff/receiver integration: seller pickup
   * targets the checkout-resolved stop; final delivery targets route.destination
   * (the buyer destination), never the market center. The receiver branch keeps
   * owning route.destination; this helper only consumes it.
   */
  private async validateActionLocation(handoff?: InternalHandoff, final = false): Promise<Response | null> {
    const run = this.state.run;
    if (!run) return notFound("run is unknown or retired");
    const target = final
      ? run.route?.destination
      : run.stops.find((stop) => stop.exchangePoint === handoff?.exchangePointId)?.location;
    let radiusMeters: number | undefined;
    try {
      const stub = this.env.MARKET_DO.get(this.env.MARKET_DO.idFromName(run.market));
      const response = await stub.fetch(new Request("http://do/config"));
      const config = MarketConfigSchema.safeParse(await response.json());
      if (response.ok && config.success) radiusMeters = config.data.geo?.radiusMeters;
    } catch { /* unresolved below; enforcement fails closed */ }
    const stored = run.location;
    const fix: LocationFix | undefined = stored?.accuracyMeters === undefined ? undefined : {
      latitude: stored.latitude, longitude: stored.longitude, observedAt: stored.observedAt, accuracyMeters: stored.accuracyMeters,
    };
    const fence: GeoFence | undefined = target && radiusMeters ? { center: target, radiusMeters } : undefined;
    const checked = validateLocationWithinFence(fix, fence, this.now());
    return checked.ok ? null : refusal(checked.code, checked.message);
  }

  /**
   * The one-time challenge was scanned. Photo-required confirm (owner decision
   * amending ADR-0019): the scan records `scannedAt` but does NOT confirm —
   * a handoff confirms only once photo evidence is attached. Photoless scans
   * are persisted (the scan happened) and answered 409 `photo-required`.
   */
  private async scan(command: HandoffChallengeScanned, enforceLocation: boolean): Promise<Response> {
    const handoff = this.findHandoff(command.handoffId);
    if (handoff instanceof Response) return handoff;
    const run = this.state.run;
    if (!run) return notFound("run is unknown or retired");
    if (command.runId !== run.id) return conflict("challenge addresses a different run");
    if (handoff.status === "confirmed") return this.confirmedEvent(handoff);
    const now = this.now();

    if (handoff.type === "delivery") {
      if (handoff.codeVerifiedAt !== undefined) return jsonResponse({ type: "handoff.challenge-verified", handoffId: handoff.id, runId: run.id, scannedAt: handoff.scannedAt });
      if ((handoff.failedCodeAttempts ?? 0) >= DELIVERY_CODE_MAX_ATTEMPTS) return refusal("code-attempt-limit", "delivery code is locked after too many failed attempts");
      if (this.state.deliveryCodeExpiresAt === undefined || now >= this.state.deliveryCodeExpiresAt) return refusal("code-expired", "delivery code has expired");
      const suppliedHash = await hashDeliveryCode(this.env, run.id, command.challenge);
      if (!this.state.deliveryCodeHash || !secretsEqual(suppliedHash, this.state.deliveryCodeHash)) {
        handoff.failedCodeAttempts = (handoff.failedCodeAttempts ?? 0) + 1;
        await this.ctx.storage.put(STATE_KEY, this.state);
        return refusal("invalid-code", `delivery code is incorrect (${DELIVERY_CODE_MAX_ATTEMPTS - handoff.failedCodeAttempts} attempts remaining)`);
      }
      handoff.codeVerifiedAt = now;
    } else {
      const expected = await pickupChallenge(this.env, run.id, handoff);
      if (!secretsEqual(command.challenge, expected)) return refusal("invalid-challenge", "QR challenge is not valid for this handoff");
    }

    handoff.scannedAt = now;
    if (handoff.type === "delivery" || handoff.photoCaptureRef === undefined) {
      run.handoffs = this.wireHandoffs();
      await this.ctx.storage.put(STATE_KEY, this.state);
      await this.scheduleAlarm();
      broadcast(this.ctx, this.env, { type: "run.updated", run: this.wireRun() });
      if (handoff.type === "delivery") return jsonResponse({ type: "handoff.challenge-verified", handoffId: handoff.id, runId: run.id, scannedAt: now });
      return refusal("photo-required", "scan recorded; capture photo evidence to complete the pickup");
    }
    if (enforceLocation) {
      const refused = await this.validateActionLocation(handoff);
      if (refused) return refused;
    }
    this.confirmHandoff(handoff, false, now, this.state.runnerId ?? "runner");
    run.handoffs = this.wireHandoffs();
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.scheduleAlarm();
    const event = this.handoffConfirmed(handoff);
    broadcast(this.ctx, this.env, event);
    broadcast(this.ctx, this.env, { type: "run.updated", run: this.wireRun() });
    return jsonResponse(event);
  }

  /**
   * Explicit confirm (internal — e.g. the buyer's delivery receipt). Idempotent:
   * confirming twice is a no-op replay. Photo-required like every confirm path:
   * without `photoCaptureRef` this stalls with 409 `photo-required`.
   */
  private async confirm(data: HandoffRefRequest, enforceLocation: boolean): Promise<Response> {
    const handoff = this.findHandoff(data.handoffId);
    if (handoff instanceof Response) return handoff;
    const run = this.state.run;
    if (!run) return notFound("run is unknown or retired");
    if (handoff.status === "confirmed") return this.confirmedEvent(handoff);
    if (handoff.photoCaptureRef === undefined || handoff.photoCapturedAt === undefined) return refusal("photo-required", "photo evidence is required before confirmation");
    if (handoff.type === "delivery") {
      if (handoff.codeVerifiedAt === undefined) return refusal("code-required", "the buyer or receiver must verify the delivery code first");
      if (handoff.photoCapturedAt < handoff.codeVerifiedAt) return refusal("fresh-photo-required", "capture a new photo after delivery code verification");
      const expectedConfirmer = run.receiver?.kind === "designated" ? "receiver" : this.state.buyerId;
      if (data.confirmedBy !== expectedConfirmer) return conflict("delivery must be explicitly confirmed by the selected buyer or designated receiver");
    } else if (data.confirmedBy !== this.state.runnerId) {
      return conflict("only the assigned runner may confirm a pickup handoff");
    }
    if (enforceLocation) {
      const refused = await this.validateActionLocation(handoff);
      if (refused) return refused;
    }
    const confirmedAt = this.now();
    this.confirmHandoff(handoff, false, confirmedAt, data.confirmedBy);
    run.handoffs = this.wireHandoffs();
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.scheduleAlarm();
    const event = this.handoffConfirmed(handoff);
    broadcast(this.ctx, this.env, event);
    broadcast(this.ctx, this.env, { type: "run.updated", run: this.wireRun() });
    return jsonResponse(event);
  }

  /**
   * Photo evidence: store the R2 reference string only. The photo IS the
   * confirm act (the runner photographs at the exchange): attaching a photo to
   * a scanned-but-unconfirmed handoff confirms it. A photo landing before the
   * scan just attaches — the scan confirms it when it arrives.
   */
  private async photo(command: HandoffPhotoCaptured, enforceLocation: boolean): Promise<Response> {
    const run = this.requireRun();
    if (run instanceof Response) return run;
    const handoff = this.findHandoff(command.handoffId);
    if (handoff instanceof Response) return handoff;
    if (handoff.status === "confirmed") return conflict("confirmed handoff evidence is immutable");
    const confirms = handoff.type === "pickup" && handoff.scannedAt !== undefined;
    if (confirms && enforceLocation) {
      const refused = await this.validateActionLocation(handoff);
      if (refused) return refused;
    }
    handoff.photoCaptureRef = command.photoCaptureRef;
    handoff.photoCapturedAt = this.now();
    if (confirms) this.confirmHandoff(handoff, false, this.now(), this.state.runnerId ?? "runner");
    run.handoffs = this.wireHandoffs();
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.scheduleAlarm();
    if (confirms) broadcast(this.ctx, this.env, this.handoffConfirmed(handoff));
    const event: ServerEvent = { type: "run.updated", run: this.wireRun() };
    broadcast(this.ctx, this.env, event);
    return jsonResponse(event);
  }

  /** Throttled fire-and-forget location stream: keep the latest fix. */
  private async location(command: RunnerLocationUpdated): Promise<Response> {
    const run = this.requireRun();
    if (run instanceof Response) return run;
    if (command.runId !== run.id) {
      return conflict(`location update addresses run ${command.runId}, not this run`);
    }
    if (this.env.ALLOW_HEADER_AUTH !== "true" && (command.observedAt === undefined || command.accuracyMeters === undefined)) {
      return conflict("location update requires device accuracy and observation time");
    }
    run.location = {
      latitude: command.latitude,
      longitude: command.longitude,
      observedAt: command.observedAt ?? this.now(),
      ...(command.accuracyMeters !== undefined ? { accuracyMeters: command.accuracyMeters } : {}),
    };
    await this.ctx.storage.put(STATE_KEY, this.state);
    const event: ServerEvent = { type: "run.updated", run: this.wireRun() };
    // Live sockets receive the throttled fix; durable notifications do not flood on GPS updates.
    broadcast(this.ctx, event);
    return jsonResponse(event);
  }

  /** Final delivery to the buyer or muster point: stamp and arm the dispute window. */
  private async finalDelivery(enforceLocation: boolean): Promise<Response> {
    const run = this.requireRun();
    if (run instanceof Response) return run;
    if (this.state.finalDeliveryAt !== undefined) {
      // Idempotent replay.
      const event: ServerEvent = { type: "run.updated", run: this.wireRun() };
      return jsonResponse(event);
    }
    if (!run.stops.every((stop) => stop.status === "completed")) {
      return conflict("every seller stop must be confirmed before final delivery");
    }
    if (this.state.handoffs.some((handoff) => handoff.status !== "confirmed")) {
      return refusal("handoff-required", "every pickup and delivery handoff must be confirmed before final delivery");
    }
    const delivery = this.state.handoffs.find((handoff) => handoff.type === "delivery");
    if (!delivery || delivery.status !== "confirmed" || delivery.autoConfirmed === true ||
        delivery.codeVerifiedAt === undefined || delivery.confirmedBy === undefined ||
        delivery.photoCapturedAt === undefined || delivery.photoCapturedAt < delivery.codeVerifiedAt) {
      return refusal("delivery-confirmation-required", "final delivery requires a code-verified, freshly photographed, explicitly confirmed delivery handoff");
    }
    if (enforceLocation) {
      const refused = await this.validateActionLocation(undefined, true);
      if (refused) return refused;
    }
    const now = this.now();
    this.state.finalDeliveryAt = now;
    run.status = "delivered";
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.scheduleAlarm();
    const event: ServerEvent = { type: "run.updated", run: this.wireRun() };
    broadcast(this.ctx, this.env,event);
    return jsonResponse(event);
  }

  /** A dispute stops the automatic release; settlement then needs human evidence. */
  private async dispute(data: DisputeRunRequest): Promise<Response> {
    const run = this.requireRun();
    if (run instanceof Response) return run;
    if (this.state.settlementReleased) return conflict("settlement was already released");
    if (this.state.disputed) return conflict("run is already disputed");
    this.state.disputed = true;
    this.state.disputeReason = data.reason;
    if (data.raisedByParticipantId !== undefined) {
      this.state.disputeRaisedByParticipantId = data.raisedByParticipantId;
    }
    // Evidence-first (ADR-0007): the dispute record gathers every handoff
    // photo reference this run already holds, plus whatever the raiser
    // attached — mismatch-of-images is the canonical dispute trigger.
    const refs = new Set<string>(data.evidenceRefs ?? []);
    for (const handoff of this.state.handoffs) {
      if (handoff.photoCaptureRef !== undefined) refs.add(handoff.photoCaptureRef);
    }
    this.state.disputeEvidenceRefs = [...refs];
    await this.ctx.storage.put(STATE_KEY, this.state);
    const event: ServerEvent = { type: "run.updated", run: this.wireRun() };
    broadcast(this.ctx, this.env,event);
    return jsonResponse({
      disputed: true,
      reason: data.reason,
      raisedByParticipantId: this.state.disputeRaisedByParticipantId ?? null,
      evidenceRefs: this.state.disputeEvidenceRefs,
    });
  }

  /**
   * Ops console adjustment — expressed ONLY through the settlement function
   * (ADR-0013): the mode and dispute evidence shape the SettlementInput; ops
   * can never move money any other way. Resolves open runs (e.g. an aborted
   * trip or an evidence-reviewed dispute) without waiting for the timers.
   */
  private async opsSettle(data: OpsSettleRequest): Promise<Response> {
    const run = this.requireRun();
    if (run instanceof Response) return run;
    if (this.state.settlementReleased) return conflict("settlement was already released");
    const dispute: SettlementInput["dispute"] =
      data.mode === "disputed"
        ? {
            ambiguous: data.ambiguous ?? true,
            ...(data.requestedPlatformLossKobo !== undefined
              ? { requestedPlatformLossKobo: data.requestedPlatformLossKobo }
              : {}),
          }
        : undefined;
    const response = await this.releaseSettlement(
      buildSettlementInput(this.state, data.mode, dispute),
      this.now(),
    );
    return jsonResponse({
      adjusted: true,
      reason: data.reason ?? null,
      settlement: await response.json(),
    });
  }

  private findHandoff(handoffId: string): InternalHandoff | Response {
    const handoff = this.state.handoffs.find((candidate) => candidate.id === handoffId);
    if (!handoff) return notFound(`handoff ${handoffId} is unknown`);
    return handoff;
  }

  private async deliveryCode(): Promise<Response> {
    const run = this.requireRun();
    if (run instanceof Response) return run;
    const issuedAt = this.state.deliveryCodeIssuedAt;
    const expiresAt = this.state.deliveryCodeExpiresAt;
    if (issuedAt === undefined || expiresAt === undefined) return notFound("delivery code is unavailable");
    if (this.now() >= expiresAt) return refusal("code-expired", "delivery code has expired");
    const issued = await issueDeliveryCode(this.env, run.id, issuedAt);
    return jsonResponse({ code: issued.code, expiresAt });
  }

  /** Rotate a delayed run's buyer-only secret; old codes and failed-attempt locks are invalidated together. */
  private async rotateDeliveryCode(): Promise<Response> {
    const run = this.requireRun();
    if (run instanceof Response) return run;
    if (run.status === "closed" || run.status === "aborted" || run.status === "delivered") {
      return conflict(`run is ${run.status}; delivery code cannot be rotated`);
    }
    if (this.state.handoffs.some((handoff) => handoff.type === "delivery" && handoff.codeVerifiedAt !== undefined)) {
      return conflict("delivery code was already verified and cannot be rotated");
    }
    const issuedAt = this.now();
    const issued = await issueDeliveryCode(this.env, run.id, issuedAt);
    this.state.deliveryCodeIssuedAt = issuedAt;
    this.state.deliveryCodeExpiresAt = issuedAt + DELIVERY_CODE_TTL_MS;
    this.state.deliveryCodeHash = issued.hash;
    for (const handoff of this.state.handoffs) {
      if (handoff.type === "delivery") handoff.failedCodeAttempts = 0;
    }
    run.handoffs = this.wireHandoffs();
    await this.ctx.storage.put(STATE_KEY, this.state);
    broadcast(this.ctx, this.env, { type: "run.updated", run: this.wireRun() });
    return jsonResponse({ code: issued.code, expiresAt: this.state.deliveryCodeExpiresAt });
  }

  private async handoffChallenge(handoffId: string): Promise<Response> {
    const run = this.requireRun();
    if (run instanceof Response) return run;
    const handoff = this.findHandoff(handoffId);
    if (handoff instanceof Response) return handoff;
    if (handoff.type !== "pickup") return conflict("delivery uses the buyer-only delivery code endpoint");
    return jsonResponse({ challenge: await pickupChallenge(this.env, run.id, handoff) });
  }

  private handoffConfirmed(handoff: InternalHandoff): ServerEvent {
    return {
      type: "handoff.confirmed",
      handoffId: handoff.id,
      runId: this.state.run?.id ?? "unknown",
      confirmedAt: handoff.confirmedAt ?? this.now(),
      ...(handoff.confirmedBy ? { confirmedBy: handoff.confirmedBy } : {}),
      autoConfirmed: handoff.autoConfirmed ?? false,
      ...this.participantAttribution(),
    };
  }

  private confirmedEvent(handoff: InternalHandoff): Response {
    return jsonResponse(this.handoffConfirmed(handoff));
  }

  /** Mark the handoff confirmed; only pickup handoffs complete seller stops. */
  private confirmHandoff(handoff: InternalHandoff, auto: boolean, at: number, confirmedBy: string): void {
    const run = this.state.run;
    if (!run) return;
    handoff.status = "confirmed";
    handoff.autoConfirmed = auto;
    handoff.confirmedAt = at;
    handoff.confirmedBy = confirmedBy;
    if (handoff.type === "delivery") return;

    const stop = run.stops.find(
      (candidate) => candidate.exchangePoint === handoff.exchangePointId && candidate.status !== "completed",
    );
    if (stop) stop.status = "completed";

    let nextAssigned = false;
    for (const candidate of run.stops) {
      if (candidate.status === "completed") continue;
      if (!nextAssigned) {
        candidate.status = "next";
        nextAssigned = true;
      } else {
        candidate.status = "upcoming";
      }
    }
    if (run.status === "collecting" && run.stops.every((candidate) => candidate.status === "completed")) {
      run.status = "delivering";
    }
  }

  private async scheduleAlarm(): Promise<void> {
    const now = this.now();
    const candidates: number[] = [];
    for (const handoff of this.state.handoffs) {
      if (handoff.type === "pickup" && handoff.status === "pending") {
        const deadline = handoff.requestedAt + HANDOFF_AUTO_CONFIRM_MS;
        // Photoless past the deadline: auto-confirm never fires without
        // evidence — re-arm a short clock so the awaiting-photo state is
        // re-broadcast and re-checked until the photo lands.
        candidates.push(deadline > now ? deadline : now + HANDOFF_AUTO_CONFIRM_MS);
      }
    }
    if (
      this.state.finalDeliveryAt !== undefined &&
      !this.state.settlementReleased &&
      !this.state.disputed
    ) {
      const releaseAt = this.state.finalDeliveryAt + DISPUTE_WINDOW_MS;
      if (releaseAt > now) candidates.push(releaseAt);
    }
    if (candidates.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  async alarm(): Promise<void> {
    // Doctrine: load state from storage at the start of the alarm.
    this.state =
      (await this.ctx.storage.get<RunState>(STATE_KEY)) ?? { legs: [], handoffs: [], settlementReleased: false, disputed: false };
    const run = this.state.run;
    if (!run) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = this.now();

    // Pickup silence may auto-confirm with evidence. Delivery never does:
    // it always needs code verification, fresh evidence, and explicit receipt.
    let handoffsChanged = false;
    for (const handoff of this.state.handoffs) {
      if (handoff.type !== "pickup" || handoff.status !== "pending") continue;
      const deadline = handoff.requestedAt + HANDOFF_AUTO_CONFIRM_MS;
      if (now < deadline) continue;
      if (handoff.photoCaptureRef === undefined) {
        handoffsChanged = true;
        continue;
      }
      if (this.state.locationRequired) {
        const refused = await this.validateActionLocation(handoff);
        if (refused) { handoffsChanged = true; continue; }
      }
      this.confirmHandoff(handoff, true, deadline, "pickup-auto-confirm");
      handoffsChanged = true;
      broadcast(this.ctx, this.env, this.handoffConfirmed(handoff));
    }
    if (handoffsChanged) {
      run.handoffs = this.wireHandoffs();
      broadcast(this.ctx, this.env,{ type: "run.updated", run: this.wireRun() });
    }

    // Dispute window lapsed with no dispute: run the settlement function with
    // the run's actual legs, release it, and archive both the settlement and
    // the retirement snapshot.
    if (
      this.state.finalDeliveryAt !== undefined &&
      !this.state.settlementReleased &&
      !this.state.disputed &&
      now >= this.state.finalDeliveryAt + DISPUTE_WINDOW_MS
    ) {
      if (!this.state.settlementConfig) {
        await this.ctx.storage.put(STATE_KEY, this.state);
        await this.scheduleAlarm();
        return;
      }
      await this.releaseSettlement(buildSettlementInput(this.state, "completed"), now);
      return;
    }

    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.scheduleAlarm();
  }

  /**
   * The ONLY way money leaves a run: call the settlement function, broadcast
   * the release, archive the settlement + retirement snapshot, delete DO
   * storage. Shared by the dispute-window alarm and the ops console's
   * settle-only adjustment path (ADR-0007, ADR-0013).
   */
  private async releaseSettlement(input: SettlementInput, now: number): Promise<Response> {
    const run = this.state.run;
    if (!run) return notFound("run is unknown or retired");
    const outcome = settle(input);
    this.state.settlementReleased = true;
    run.status = input.mode === "aborted" ? "aborted" : "closed";

    const released: ServerEvent = {
      type: "settlement.released",
      runId: run.id,
      buyerId: this.state.buyerId ?? "buyer:anonymous",
      runnerId: this.state.runnerId ?? "runner:internal",
      mode: input.mode,
      sellers: outcome.sellers,
      runnerKobo: outcome.runnerKobo,
      platformKobo: outcome.platformKobo,
      buyerRefundKobo: outcome.buyerRefundKobo,
      platformLossKobo: outcome.platformLossKobo,
      releasedAt: now,
      inputs: input,
      // Correlation: the seeding checkout's request id (x-request-id), carried
      // through DO state so timer-driven closes join the same trace.
      ...(this.state.requestId !== undefined ? { requestId: this.state.requestId } : {}),
    };
    const retirementSnapshot: ServerEvent = {
      type: "run.retired",
      runId: run.id,
      cartId: run.id.startsWith("run:") ? run.id.slice(4) : run.id,
      market: run.market,
      buyerId: this.state.buyerId ?? "buyer:anonymous",
      runnerId: this.state.runnerId ?? "runner:internal",
      status: run.status,
      floorRateKobo: run.floorRateKobo,
      delivery: run.delivery,
      stops: run.stops,
      mode: input.mode,
      settlementLegs: outcome.sellers,
      runnerKobo: outcome.runnerKobo,
      platformKobo: outcome.platformKobo,
      buyerRefundKobo: outcome.buyerRefundKobo,
      platformLossKobo: outcome.platformLossKobo,
      closedAt: now,
      // The durable evidence layer (ADR-0007): handoffs carry their signed
      // photo refs and scan/confirm timestamps into the archive snapshot.
      handoffs: this.wireHandoffs(),
      ...(this.state.disputed
        ? {
            dispute: {
              reason: this.state.disputeReason ?? "disputed",
              raisedByParticipantId: this.state.disputeRaisedByParticipantId ?? null,
              evidenceRefs: this.state.disputeEvidenceRefs ?? [],
            },
          }
        : {}),
      ...(this.state.requestId !== undefined ? { requestId: this.state.requestId } : {}),
    };
    broadcast(this.ctx, this.env,released);
    broadcast(this.ctx, this.env,retirementSnapshot);
    // Archive order matters: run.retired first so the settlement_records
    // foreign key to runs_archive is satisfied within the same batch.
    await this.env.ARCHIVE_QUEUE.sendBatch([
      { body: serializeEvent(retirementSnapshot) },
      { body: serializeEvent(released) },
    ]);
    await this.ctx.storage.deleteAll();
    return jsonResponse(released);
  }

  /**
   * The wire handoff: the live status plus the evidence layer (ADR-0007) —
   * the runner's photo reference and the scan/confirm timestamps — so every
   * counterparty (seller at pickup, buyer at delivery) can SEE the evidence
   * while deciding whether to confirm or dispute. `awaitingPhoto` marks a
   * handoff past its auto-confirm deadline with no photo yet (photo-required
   * confirm, ADR-0019 as amended). All fields additive.
   */
  private wireHandoffs(): RunHandoff[] {
    const now = this.now();
    return this.state.handoffs.map((handoff) => ({
      id: handoff.id,
      type: handoff.type,
      exchangePoint: handoff.exchangePointId,
      counterparty: handoff.counterparty,
      status: handoff.status,
      requestedAt: handoff.requestedAt,
      ...(handoff.photoCaptureRef !== undefined ? { photoCaptureRef: handoff.photoCaptureRef } : {}),
      ...(handoff.photoCapturedAt !== undefined ? { photoCapturedAt: handoff.photoCapturedAt } : {}),
      ...(handoff.scannedAt !== undefined ? { scannedAt: handoff.scannedAt } : {}),
      ...(handoff.confirmedAt !== undefined ? { confirmedAt: handoff.confirmedAt } : {}),
      ...(handoff.confirmedBy !== undefined ? { confirmedBy: handoff.confirmedBy } : {}),
      ...(handoff.autoConfirmed !== undefined ? { autoConfirmed: handoff.autoConfirmed } : {}),
      ...(handoff.type === "delivery" && this.state.deliveryCodeExpiresAt !== undefined ? { codeExpiresAt: this.state.deliveryCodeExpiresAt } : {}),
      ...(handoff.type === "pickup" && handoff.status === "pending" &&
      handoff.photoCaptureRef === undefined &&
      now >= handoff.requestedAt + HANDOFF_AUTO_CONFIRM_MS
        ? { awaitingPhoto: true }
        : {}),
    }));
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    handleWebSocketMessage(ws, message);
    this.telemetry.beat(this.env, this.ctx.id.name ?? "unknown", this.state.run?.market, true);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    handleWebSocketClose(ws, code, reason);
    this.telemetry.beat(this.env, this.ctx.id.name ?? "unknown", this.state.run?.market, true);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    handleWebSocketError(ws);
  }
}
