import { DurableObject } from "cloudflare:workers";
import { DISPUTE_WINDOW_MS, HANDOFF_AUTO_CONFIRM_MS, settle } from "@market-runs/domain";
import type {
  HandoffChallengeScanned,
  HandoffPhotoCaptured,
  RunnerLocationUpdated,
  Run,
  RunHandoff,
  ServerEvent,
} from "@market-runs/proto";
import type { Env } from "../env.js";
import {
  STATE_KEY,
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
  serializeEvent,
} from "../protocol.js";
import {
  DisputeRunRequestSchema,
  HandoffRefRequestSchema,
  InitiateHandoffRequestSchema,
  SeedRunRequestSchema,
  type DisputeRunRequest,
  type HandoffRefRequest,
  type InitiateHandoffRequest,
  type SeedRunRequest,
} from "../internal.js";

interface InternalHandoff {
  id: string;
  exchangePointId: string;
  counterparty: string;
  status: "pending" | "confirmed";
  requestedAt: number;
  /** R2 reference string only — media bytes never pass through the RunDO. */
  photoCaptureRef?: string;
  scannedAt?: number;
  autoConfirmed?: boolean;
  confirmedAt?: number;
}

interface SettlementConfig {
  goodsCommissionBps: number;
  deliveryMarginKobo: number;
}

interface RunState {
  run?: Run;
  /** Per-seller goods totals for the settlement function. */
  legs: Array<{ sellerId: string; amountKobo: number }>;
  settlementConfig?: SettlementConfig;
  handoffs: InternalHandoff[];
  finalDeliveryAt?: number;
  settlementReleased: boolean;
  disputed: boolean;
  /** Deterministic-time seam: epoch offset added to Date.now(). 0 in production. */
  timeOffsetMs?: number;
}

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
      return internalErrorGuard(() => this.seed(parsed.data));
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
    if (request.method === "GET" && path === "/") {
      const run = this.state.run;
      if (!run) return notFound("run is unknown or retired");
      const event: ServerEvent = { type: "run.updated", run };
      return jsonResponse(event);
    }
    return notFound(`RunDO route not found: ${request.method} ${path}`);
  }

  private requireRun(): Run | Response {
    const run = this.state.run;
    if (!run) return notFound("run is unknown or retired");
    return run;
  }

  /** CartDO seeds the run at checkout: stops, settlement legs, coefficients. */
  private async seed(data: SeedRunRequest): Promise<Response> {
    if (this.state.run) {
      // Idempotent re-seed of the same run.
      const event: ServerEvent = { type: "run.updated", run: this.state.run };
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
    };
    this.state.run = run;
    this.state.legs = data.legs;
    this.state.settlementConfig = data.settlement;
    await this.ctx.storage.put(STATE_KEY, this.state);
    const event: ServerEvent = { type: "run.updated", run };
    broadcast(this.ctx, event);
    return jsonResponse(event);
  }

  /** A handoff opens: the 3-min auto-confirm clock starts (buyer silence = consent). */
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
    broadcast(this.ctx, { type: "run.updated", run });
    return jsonResponse(event);
  }

  /** The one-time challenge was scanned: confirm the handoff explicitly. */
  private async scan(command: HandoffChallengeScanned): Promise<Response> {
    const handoff = this.findHandoff(command.handoffId);
    if (handoff instanceof Response) return handoff;
    const run = this.state.run;
    if (!run) return notFound("run is unknown or retired");
    handoff.scannedAt = command.scannedAt;
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
    broadcast(this.ctx, { type: "run.updated", run });
    return jsonResponse(event);
  }

  /** Explicit confirm (internal). Idempotent: confirming twice is a no-op replay. */
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
    broadcast(this.ctx, { type: "run.updated", run });
    return jsonResponse(event);
  }

  /** Photo evidence: store the R2 reference string only. */
  private async photo(command: HandoffPhotoCaptured): Promise<Response> {
    const run = this.requireRun();
    if (run instanceof Response) return run;
    const handoff = this.findHandoff(command.handoffId);
    if (handoff instanceof Response) return handoff;
    handoff.photoCaptureRef = command.photoCaptureRef;
    run.handoffs = this.wireHandoffs();
    await this.ctx.storage.put(STATE_KEY, this.state);
    const event: ServerEvent = { type: "run.updated", run };
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
    const event: ServerEvent = { type: "run.updated", run };
    broadcast(this.ctx, event);
    return jsonResponse(event);
  }

  /** Final delivery to the buyer or muster point: stamp and arm the dispute window. */
  private async finalDelivery(): Promise<Response> {
    const run = this.requireRun();
    if (run instanceof Response) return run;
    if (this.state.finalDeliveryAt !== undefined) {
      // Idempotent replay.
      const event: ServerEvent = { type: "run.updated", run };
      return jsonResponse(event);
    }
    if (!run.stops.every((stop) => stop.status === "completed")) {
      return conflict("every seller stop must be confirmed before final delivery");
    }
    const now = this.now();
    this.state.finalDeliveryAt = now;
    run.status = "delivered";
    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.scheduleAlarm();
    const event: ServerEvent = { type: "run.updated", run };
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
    await this.ctx.storage.put(STATE_KEY, this.state);
    const event: ServerEvent = { type: "run.updated", run };
    broadcast(this.ctx, event);
    return jsonResponse({ disputed: true, reason: data.reason });
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
        if (deadline > now) candidates.push(deadline);
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

    // Buyer silence = consent: auto-confirm handoffs past their deadline.
    for (const handoff of this.state.handoffs) {
      if (handoff.status !== "pending") continue;
      const deadline = handoff.requestedAt + HANDOFF_AUTO_CONFIRM_MS;
      if (now < deadline) continue;
      this.confirmHandoff(handoff, true, deadline);
      run.handoffs = this.wireHandoffs();
      broadcast(this.ctx, {
        type: "handoff.confirmed",
        handoffId: handoff.id,
        runId: run.id,
        confirmedAt: deadline,
        autoConfirmed: true,
      });
    }
    if (this.state.handoffs.some((handoff) => handoff.autoConfirmed)) {
      broadcast(this.ctx, { type: "run.updated", run });
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
      const config = this.state.settlementConfig;
      if (!config) {
        await this.ctx.storage.put(STATE_KEY, this.state);
        await this.scheduleAlarm();
        return;
      }
      const outcome = settle({
        mode: "completed",
        sellers: this.state.legs.map((leg) => ({
          sellerId: leg.sellerId,
          amountKobo: leg.amountKobo,
          stopCompleted:
            run.stops.find((stop) => stop.sellerName === leg.sellerId)?.status === "completed",
        })),
        deliveryPriceKobo: run.floorRateKobo,
        deliveryMarginKobo: config.deliveryMarginKobo,
        goodsCommissionBps: config.goodsCommissionBps,
      });
      this.state.settlementReleased = true;
      run.status = "closed";

      const released: ServerEvent = {
        type: "settlement.released",
        runId: run.id,
        mode: "completed",
        sellers: outcome.sellers,
        runnerKobo: outcome.runnerKobo,
        platformKobo: outcome.platformKobo,
        buyerRefundKobo: outcome.buyerRefundKobo,
        platformLossKobo: outcome.platformLossKobo,
        releasedAt: now,
      };
      const retirementSnapshot: ServerEvent = {
        type: "run.retired",
        runId: run.id,
        cartId: run.id.startsWith("run:") ? run.id.slice(4) : run.id,
        market: run.market,
        status: run.status,
        floorRateKobo: run.floorRateKobo,
        delivery: run.delivery,
        stops: run.stops,
        mode: "completed",
        settlementLegs: outcome.sellers,
        runnerKobo: outcome.runnerKobo,
        platformKobo: outcome.platformKobo,
        buyerRefundKobo: outcome.buyerRefundKobo,
        platformLossKobo: outcome.platformLossKobo,
        closedAt: now,
      };
      broadcast(this.ctx, released);
      broadcast(this.ctx, retirementSnapshot);
      await this.env.ARCHIVE_QUEUE.sendBatch([
        { body: serializeEvent(released) },
        { body: serializeEvent(retirementSnapshot) },
      ]);
      await this.ctx.storage.deleteAll();
      return;
    }

    await this.ctx.storage.put(STATE_KEY, this.state);
    await this.scheduleAlarm();
  }

  private wireHandoffs(): RunHandoff[] {
    return this.state.handoffs.map((handoff) => ({
      id: handoff.id,
      exchangePoint: handoff.exchangePointId,
      counterparty: handoff.counterparty,
      status: handoff.status,
      requestedAt: handoff.requestedAt,
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
