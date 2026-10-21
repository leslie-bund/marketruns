import { DurableObject } from "cloudflare:workers";
import type { Participant, ParticipantOnboarded, ServerEvent } from "@market-runs/proto";
import type { Env } from "../config/env.js";
import {
  acceptHibernatedWebSocket,
  broadcast,
  expectCommand,
  handleWebSocketClose,
  handleWebSocketError,
  handleWebSocketMessage,
  internalErrorGuard,
  isWebSocketUpgrade,
  jsonResponse,
  notFound,
  parseClientCommand,
} from "./runtime/index.js";
import { STATE_KEY } from "./state.js";
import { devIdentityVerifier, hashIdDocument } from "../kyc/verifier.js";

/**
 * The Durable Object name for one participant's registry record. Every
 * ParticipantDO call site must key through this — the pre-rekey world
 * registry lived in a single object named "participants" (see below).
 */
export function participantObjectName(participantId: string): string {
  return `participant:${participantId}`;
}

/**
 * The pre-rekey single world registry. Dev-stage state only (ADR-0016):
 * GET reads fall back to it so participants onboarded before per-participant
 * keying stay readable; no writes ever target it again.
 */
export const LEGACY_REGISTRY_NAME = "participants";

/** The pre-rekey storage shape, kept only so the legacy object stays readable. */
interface LegacyRegistryState {
  participants: Participant[];
}

function asLegacyRegistry(stored: unknown): LegacyRegistryState | null {
  if (stored !== null && typeof stored === "object" && Array.isArray((stored as LegacyRegistryState).participants)) {
    return stored as LegacyRegistryState;
  }
  return null;
}

/**
 * One participant's registry record (ADR-0016 dev-stage home): onboarding,
 * KYC verification through the identity-verifier seam (ADR-0009), and the
 * joined-markets list.
 *
 * Keyed one object per participant (`participant:<participantId>`). The
 * single-object registry it replaces put every participant in one JSON blob
 * (O(N) read-modify-write per onboard/join, hard failure at the 2 MB DO
 * value limit around a few thousand participants) and parked the whole world
 * registry on the vendor KYC await. Per-participant keying makes onboarding
 * and joins O(1), and vendor KYC latency isolation is now per-participant:
 * the verifier await below stalls only the caller's own object.
 *
 * Storage shape: a single `Participant` under STATE_KEY. One legacy shape is
 * recognised on reads — the pre-rekey `{ participants: [...] }` blob in the
 * object named "participants" — so dev state onboarded before the rekey
 * stays readable without a migration script (clean break per ADR-0016;
 * Postgres-anchoring remains deferred to the auth/KYC decision block).
 */
export class ParticipantDO extends DurableObject<Env> {
  private participant: Participant | null = null;
  private legacy: LegacyRegistryState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    // Doctrine: load state from storage at the start of every fetch.
    const stored = await this.ctx.storage.get<unknown>(STATE_KEY);
    this.legacy = asLegacyRegistry(stored);
    this.participant = this.legacy === null ? ((stored as Participant | undefined) ?? null) : null;
    const url = new URL(request.url);
    const path = url.pathname.endsWith("/") && url.pathname.length > 1 ? url.pathname.slice(0, -1) : url.pathname;

    if (isWebSocketUpgrade(request)) return acceptHibernatedWebSocket(this.ctx);

    if (request.method === "POST" && path === "/onboard") {
      const parsed = await parseClientCommand(request);
      const command = expectCommand(parsed, "participant.onboarded");
      if (command instanceof Response) return command;
      return internalErrorGuard(() => this.onboard(command));
    }
    if (request.method === "POST" && path === "/join") {
      const parsed = await parseClientCommand(request);
      const command = expectCommand(parsed, "market.joined");
      if (command instanceof Response) return command;
      return internalErrorGuard(() => this.join(command.market, command.participantId));
    }
    if (request.method === "GET" && path.startsWith("/participant/")) {
      const id = decodeURIComponent(path.slice("/participant/".length));
      const participant =
        this.participant !== null && this.participant.id === id
          ? this.participant
          : (this.legacy?.participants.find((candidate) => candidate.id === id) ?? null);
      if (!participant) return notFound("participant is unknown");
      return jsonResponse({ participant });
    }
    return notFound(`ParticipantDO route not found: ${request.method} ${path}`);
  }

  /**
   * Onboard: verify through the vendor-neutral seam, store the participant
   * with the document hash (never the raw number), and join the first market.
   * Failed verification records the participant as failed — retry is a new
   * onboarding with a new id; the record is the audit trail (ADR-0004).
   */
  private async onboard(command: ParticipantOnboarded): Promise<Response> {
    if (this.participant) {
      // Idempotent replay of the same onboarding.
      const event: ServerEvent = { type: "participant.recorded", participant: this.participant };
      return jsonResponse(event);
    }

    // Only this participant's object waits on the vendor await — KYC latency
    // is isolated per participant.
    const kycStatus = await devIdentityVerifier.verify({
      participantId: command.participantId,
      idDocumentType: command.idDocumentType,
      idDocument: command.idDocument,
      facialCaptureRef: command.facialCaptureRef,
    });

    const participant: Participant = {
      id: command.participantId,
      role: command.role,
      displayName: command.displayName,
      kycStatus,
      idDocumentType: command.idDocumentType,
      idDocumentHash: await hashIdDocument(command.idDocument),
      facialCaptureRef: command.facialCaptureRef,
      markets: [command.market],
      createdAt: Date.now(),
    };
    await this.ctx.storage.put(STATE_KEY, participant);
    this.participant = participant;

    const event: ServerEvent = { type: "participant.recorded", participant };
    broadcast(this.ctx, event);
    return jsonResponse(event);
  }

  /** Join another market (idempotent per participant). */
  private async join(market: string, participantId: string): Promise<Response> {
    if (!this.participant || this.participant.id !== participantId) {
      return notFound(`participant ${participantId} is unknown`);
    }
    if (!this.participant.markets.includes(market)) {
      this.participant.markets.push(market);
      await this.ctx.storage.put(STATE_KEY, this.participant);
    }
    const event: ServerEvent = { type: "participant.recorded", participant: this.participant };
    broadcast(this.ctx, event);
    return jsonResponse(event);
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
