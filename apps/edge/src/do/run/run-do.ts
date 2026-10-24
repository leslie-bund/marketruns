import { DurableObject } from "cloudflare:workers";
import { DISPUTE_WINDOW_MS, HANDOFF_AUTO_CONFIRM_MS, settle } from "@market-runs/domain";
import type { SettlementInput } from "@market-runs/domain";
import { buildSettlementInput } from "./settlement.js";
import { buildPaymentDispatchRequest, buildPaymentRefundRequest } from "./payment-dispatch.js";
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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

    if (isWebSocketUpgrade(request)) return acceptHibernatedWebSocket(this.ctx);

    if (request.method === "POST" && path === "/seed") {
      const parsed = await parseInternal(request, SeedRunRequestSchema);
      if (!parsed.ok) return parsed.response;
      return internalErrorGuard(() => this.seed(parsed.data, request.headers.get("x-request-id") ?? undefined));
    }
    if (request.method === "POST" && path === "/claim") {
      const parsed = await parseInternal(request, ClaimRunRequestSchema);
      if (!parsed.ok) return parsed.response;
      return internalErrorGuard(() => this.claim(parsed.data));
    }
    if (request.method === "POST" && request.headers.get("x-resolved-participant-source") === "session" &&
        (path.startsWith("/handoff/") || path === "/location" || path === "/delivery/final")) {
      if (this.state.runnerId !== request.headers.get("x-resolved-participant-id")) {
        return conflict("only the runner who claimed this run may mutate it");
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
      return internalErrorGuard(() => this.scan(command));
    }
    if (request.method === "POST" && path === "/handoff/confirm") {
      const parsed = await parseInternal(request, HandoffRefRequestSchema);
      if (!parsed.ok) return parsed.response;
      return internalErrorGuard(() => this.confirm(parsed.data));
    }
    if (request.method === "POST" && path === "/handoff/photo") {
      const parsed = await parseClientCommand(request);
      const command = expectCommand(parsed, "handoff.photo-captured");
      if (command instanceof Response) return command;
      return internalErrorGuard(() => this.photo(command));
    }
    if (request.method === "POST" && path === "/location") {
      const parsed = await parseClientCommand(request);
      const command = expectCommand(parsed, "run.location-updated");
      if (command instanceof Response) return command;
      return internalErrorGuard(() => this.location(command));
    }
    if (request.method === "POST" && path === "/delivery/final") {
      return internalErrorGuard(() => this.finalDelivery());
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
      disputed: this.state.disputed,
      disputeRaisedByParticipantId: this.state.disputeRaisedByParticipantId ?? null,
      finalDeliveryAt: this.state.finalDeliveryAt ?? null,
    };
  }

  /** CartDO seeds the run at checkout: stops, settlement legs, coefficients. */
  private async seed(data: SeedRunRequest, requestId?: string): Promise<Response> {
    if (this.state.run) {
      // Idempotent re-seed of the same run.
      const event: ServerEvent = { type: "run.updated", run: this.wireRun() };
      return jsonResponse(event);
    }
    const run: Run = {
      id: data.run.id,
      market: data.run.market,
      status: data.run.status,
      floorRateKobo: data.run.floorRateKobo,
      delivery: data.run.delivery,
      stops: data.run.stops,
      handoffs: [],
      ...(data.run.route !== undefined ? { route: data.run.route } : {}),
    };
    this.state.run = run;
    this.state.legs = data.legs;
    this.state.settlementConfig = data.settlement;
    this.state.buyerId = data.buyerId;
    this.state.runnerId = data.runnerId;
    this.state.startedAt = this.now();
    this.state.storeIds = [...new Set(run.stops.map((stop) => stop.storeId ?? stop.sellerName))];
    if (requestId !== undefined) this.state.requestId = requestId;
    await this.ctx.storage.put(STATE_KEY, this.state);
    const event: ServerEvent = { type: "run.updated", run: this.wireRun() };
    broadcast(this.ctx, event);
    return jsonResponse(event);
  }

  /** Single-threaded DO transition: exactly one pool runner can claim an unassigned run. */
  private async claim(data: ClaimRunRequest): Promise<Response> {
    const run = this.requireRun();
    if (run instanceof Response) return run;
    if (this.state.runnerId && this.state.runnerId !== data.participantId) return conflict("run was already claimed by another runner");
    if (!this.state.runnerId && run.status !== "unassigned") return conflict(`run is ${run.status} and cannot be claimed`);
    this.state.runnerId = data.participantId;
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
    if (run.status === "closed" || run.status === "aborted") {
      return conflict(`run is ${run.status}; no new handoffs`);
    }
    if (this.state.handoffs.some((handoff) => handoff.id === data.handoffId)) {
      return conflict(`handoff ${data.handoffId} already exists`);
    }
    const now = this.now();
    this.state.handoffs.push({
      id: data.handoffId,
      exchangePointId: data.exchangePointId,
      counterparty: data.counterparty,
      status: "pending",
      requestedAt: now,
    });
    if (run.status === "assigned") run.status = "collecting";
    run.handoffs = this.wireHandoffs();
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.scheduleAlarm();

    const deadline = now + HANDOFF_AUTO_CONFIRM_MS;
    const event: ServerEvent = {
      type: "handoff.initiated",
      handoffId: data.handoffId,
      runId: run.id,
      exchangePointId: data.exchangePointId,
      counterparty: data.counterparty,
      requestedAt: now,
      deadline,
    };
    broadcast(this.ctx, event);
    broadcast(this.ctx, { type: "run.updated", run: this.wireRun() });
    return jsonResponse(event);
  }

  /**
   * The one-time challenge was scanned. Photo-required confirm (owner decision
   * amending ADR-0019): the scan records `scannedAt` but does NOT confirm —
   * a handoff confirms only once photo evidence is attached. Photoless scans
   * are persisted (the scan happened) and answered 409 `photo-required`.
   */
  private async scan(command: HandoffChallengeScanned): Promise<Response> {
    const handoff = this.findHandoff(command.handoffId);
    if (handoff instanceof Response) return handoff;
    const run = this.state.run;
    if (!run) return notFound("run is unknown or retired");
    if (handoff.status === "confirmed") {
      // Idempotent: a confirmed handoff re-confirms to the same result.
      const event: ServerEvent = {
        type: "handoff.confirmed",
        handoffId: handoff.id,
        runId: run.id,
        confirmedAt: handoff.confirmedAt ?? this.now(),
        autoConfirmed: handoff.autoConfirmed ?? false,
      };
      return jsonResponse(event);
    }
    // The one-time challenge is scanned once: the first scan's stamp stands.
    if (handoff.scannedAt === undefined) handoff.scannedAt = command.scannedAt;
    if (handoff.photoCaptureRef === undefined) {
      // Scanned but no evidence yet: pending → scanned, waiting on the photo.
      run.handoffs = this.wireHandoffs();
      await this.ctx.storage.put(STATE_KEY, this.state);
      await this.scheduleAlarm();
      broadcast(this.ctx, { type: "run.updated", run: this.wireRun() });
      return refusal(
        "photo-required",
        "scan recorded, but a handoff cannot confirm without photo evidence — capture the photo to complete the handoff",
      );
    }
    const confirmedAt = this.now();
    this.confirmHandoff(handoff, false, confirmedAt);
    run.handoffs = this.wireHandoffs();
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.scheduleAlarm();
    const event: ServerEvent = {
      type: "handoff.confirmed",
      handoffId: handoff.id,
      runId: run.id,
      confirmedAt,
      autoConfirmed: false,
    };
    broadcast(this.ctx, event);
    broadcast(this.ctx, { type: "run.updated", run: this.wireRun() });
    return jsonResponse(event);
  }

  /**
   * Explicit confirm (internal — e.g. the buyer's delivery receipt). Idempotent:
   * confirming twice is a no-op replay. Photo-required like every confirm path:
   * without `photoCaptureRef` this stalls with 409 `photo-required`.
   */
  private async confirm(data: HandoffRefRequest): Promise<Response> {
    const handoff = this.findHandoff(data.handoffId);
    if (handoff instanceof Response) return handoff;
    const run = this.state.run;
    if (!run) return notFound("run is unknown or retired");
    if (handoff.status === "confirmed") {
      const event: ServerEvent = {
        type: "handoff.confirmed",
        handoffId: handoff.id,
        runId: run.id,
        confirmedAt: handoff.confirmedAt ?? this.now(),
        autoConfirmed: handoff.autoConfirmed ?? false,
      };
      return jsonResponse(event);
    }
    if (handoff.photoCaptureRef === undefined) {
      return refusal(
        "photo-required",
        "a handoff cannot confirm without photo evidence — the runner's photo is the confirm act",
      );
    }
    const confirmedAt = this.now();
    this.confirmHandoff(handoff, false, confirmedAt);
    run.handoffs = this.wireHandoffs();
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.scheduleAlarm();
    const event: ServerEvent = {
      type: "handoff.confirmed",
      handoffId: handoff.id,
      runId: run.id,
      confirmedAt,
      autoConfirmed: false,
    };
    broadcast(this.ctx, event);
    broadcast(this.ctx, { type: "run.updated", run: this.wireRun() });
    return jsonResponse(event);
  }

  /**
   * Photo evidence: store the R2 reference string only. The photo IS the
   * confirm act (the runner photographs at the exchange): attaching a photo to
   * a scanned-but-unconfirmed handoff confirms it. A photo landing before the
   * scan just attaches — the scan confirms it when it arrives.
   */
  private async photo(command: HandoffPhotoCaptured): Promise<Response> {
    const run = this.requireRun();
    if (run instanceof Response) return run;
    const handoff = this.findHandoff(command.handoffId);
    if (handoff instanceof Response) return handoff;
    handoff.photoCaptureRef = command.photoCaptureRef;
    handoff.photoCapturedAt = command.capturedAt;
    const confirms = handoff.status === "pending" && handoff.scannedAt !== undefined;
    if (confirms) this.confirmHandoff(handoff, false, this.now());
    run.handoffs = this.wireHandoffs();
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.scheduleAlarm();
    if (confirms) {
      broadcast(this.ctx, {
        type: "handoff.confirmed",
        handoffId: handoff.id,
        runId: run.id,
        confirmedAt: handoff.confirmedAt ?? this.now(),
        autoConfirmed: false,
      });
    }
    const event: ServerEvent = { type: "run.updated", run: this.wireRun() };
    broadcast(this.ctx, event);
    return jsonResponse(event);
  }

  /** Throttled fire-and-forget location stream: keep the latest fix. */
  private async location(command: RunnerLocationUpdated): Promise<Response> {
    const run = this.requireRun();
    if (run instanceof Response) return run;
    if (command.runId !== run.id) {
      return conflict(`location update addresses run ${command.runId}, not this run`);
    }
    run.location = {
      latitude: command.latitude,
      longitude: command.longitude,
      observedAt: command.observedAt,
    };
    await this.ctx.storage.put(STATE_KEY, this.state);
    const event: ServerEvent = { type: "run.updated", run: this.wireRun() };
    broadcast(this.ctx, event);
    return jsonResponse(event);
  }

  /** Final delivery to the buyer or muster point: stamp and arm the dispute window. */
  private async finalDelivery(): Promise<Response> {
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
    // Photo-required confirm (ADR-0019 as amended): a run cannot reach final
    // delivery — and therefore settlement release — with a handoff still
    // waiting on photo evidence.
    if (this.state.handoffs.some((handoff) => handoff.status !== "confirmed")) {
      return refusal(
        "photo-required",
        "every handoff must be confirmed before final delivery — a pending handoff is waiting on runner photo evidence",
      );
    }
    const now = this.now();
    this.state.finalDeliveryAt = now;
    run.status = "delivered";
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.scheduleAlarm();
    const event: ServerEvent = { type: "run.updated", run: this.wireRun() };
    broadcast(this.ctx, event);
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
    broadcast(this.ctx, event);
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

  /** Mark the handoff confirmed, complete its stop, promote the next one. */
  private confirmHandoff(handoff: InternalHandoff, auto: boolean, at: number): void {
    const run = this.state.run;
    if (!run) return;
    handoff.status = "confirmed";
    handoff.autoConfirmed = auto;
    handoff.confirmedAt = at;

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
      if (handoff.status === "pending") {
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

    // Buyer silence = consent — but never photoless (ADR-0019 as amended):
    // auto-confirm fires only when the runner's photo evidence is attached.
    // A photoless handoff past its deadline stays pending, is marked
    // `awaitingPhoto` on the wire, and the alarm re-arms (scheduleAlarm below).
    let handoffsChanged = false;
    for (const handoff of this.state.handoffs) {
      if (handoff.status !== "pending") continue;
      const deadline = handoff.requestedAt + HANDOFF_AUTO_CONFIRM_MS;
      if (now < deadline) continue;
      if (handoff.photoCaptureRef === undefined) {
        handoffsChanged = true; // awaitingPhoto flips on the wire
        continue;
      }
      this.confirmHandoff(handoff, true, deadline);
      handoffsChanged = true;
      broadcast(this.ctx, {
        type: "handoff.confirmed",
        handoffId: handoff.id,
        runId: run.id,
        confirmedAt: deadline,
        autoConfirmed: true,
      });
    }
    if (handoffsChanged) {
      run.handoffs = this.wireHandoffs();
      broadcast(this.ctx, { type: "run.updated", run: this.wireRun() });
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
    broadcast(this.ctx, released);
    broadcast(this.ctx, retirementSnapshot);
    // Archive order matters: run.retired first so the settlement_records
    // foreign key to runs_archive is satisfied within the same batch.
    await this.env.ARCHIVE_QUEUE.sendBatch([
      { body: serializeEvent(retirementSnapshot) },
      { body: serializeEvent(released) },
    ]);
    // Money movement (ADR-0007): the settlement function already decided the
    // splits — this message is the EXECUTION request for those legs, sent to
    // the payment queue where a vendor-neutral dispatcher (ADR-0009) moves
    // the money. Fire-and-forget like the location stream: the consumer is
    // idempotent on settlement:<settlementRecordId>, so a duplicate release
    // (settlementReleased is set in memory before the sends) is a safe replay.
    const dispatchRequest = buildPaymentDispatchRequest(outcome, {
      runId: run.id,
      market: run.market,
      runnerId: this.state.runnerId ?? "runner:internal",
      ...(this.state.requestId !== undefined ? { requestId: this.state.requestId } : {}),
    });
    if (dispatchRequest.legs.length > 0) {
      await this.env.PAYMENT_QUEUE.send(serializeEvent(dispatchRequest)).catch((error: unknown) => {
        console.error(JSON.stringify({ event: "payment.dispatch_enqueue_failed", runId: run.id, error: String(error) }));
      });
    }
    // Buyer refund leg: releases against the buyer's hold, never a payout
    // transfer (ADR-0023). Same fire-and-forget, idempotent-consumer posture
    // as the dispatch request above.
    const refundRequest = buildPaymentRefundRequest(outcome, {
      runId: run.id,
      buyerId: this.state.buyerId ?? "buyer:anonymous",
      ...(this.state.requestId !== undefined ? { requestId: this.state.requestId } : {}),
    });
    if (refundRequest) {
      await this.env.PAYMENT_QUEUE.send(serializeEvent(refundRequest)).catch((error: unknown) => {
        console.error(JSON.stringify({ event: "payment.refund_enqueue_failed", runId: run.id, error: String(error) }));
      });
    }
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
      exchangePoint: handoff.exchangePointId,
      counterparty: handoff.counterparty,
      status: handoff.status,
      requestedAt: handoff.requestedAt,
      ...(handoff.photoCaptureRef !== undefined ? { photoCaptureRef: handoff.photoCaptureRef } : {}),
      ...(handoff.photoCapturedAt !== undefined ? { photoCapturedAt: handoff.photoCapturedAt } : {}),
      ...(handoff.scannedAt !== undefined ? { scannedAt: handoff.scannedAt } : {}),
      ...(handoff.confirmedAt !== undefined ? { confirmedAt: handoff.confirmedAt } : {}),
      ...(handoff.autoConfirmed !== undefined ? { autoConfirmed: handoff.autoConfirmed } : {}),
      ...(handoff.status === "pending" &&
      handoff.photoCaptureRef === undefined &&
      now >= handoff.requestedAt + HANDOFF_AUTO_CONFIRM_MS
        ? { awaitingPhoto: true }
        : {}),
    }));
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    handleWebSocketMessage(ws, message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    handleWebSocketClose(ws, code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    handleWebSocketError(ws);
  }
}
