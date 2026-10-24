import { DurableObject } from "cloudflare:workers";
import { TelemetryReporter } from "./telemetry.js";
import type { Participant, ParticipantOnboarded, ServerEvent } from "@market-runs/proto";
import { NotificationSchema, type NotificationCreated } from "@market-runs/proto";
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
  safeSend,
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
  private telemetry: TelemetryReporter;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.telemetry = new TelemetryReporter(ctx, "ParticipantDO");
  }

  async fetch(request: Request): Promise<Response> {
    // Doctrine: load state from storage at the start of every fetch.
    const stored = await this.ctx.storage.get<unknown>(STATE_KEY);
    this.legacy = asLegacyRegistry(stored);
    this.participant = this.legacy === null ? ((stored as Participant | undefined) ?? null) : null;
    const url = new URL(request.url);
    const path = url.pathname.endsWith("/") && url.pathname.length > 1 ? url.pathname.slice(0, -1) : url.pathname;

    const objectName = this.ctx.id.name ?? "unknown";
    this.telemetry.beat(this.env, objectName);
    if (isWebSocketUpgrade(request)) return acceptHibernatedWebSocket(this.ctx, request);
    if (request.method === "GET" && path === "/ops/telemetry") return this.telemetry.snapshot(this.env, objectName);

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
    if (request.method === "POST" && path === "/notify") {
      let body: unknown;
      try { body = await request.json(); } catch { return jsonResponse({ delivered: 0 }); }
      const parsed = NotificationSchema.safeParse(body);
      if (!parsed.success) return notFound("notification failed validation");
      const frame: NotificationCreated = { type: "notification.created", notification: parsed.data };
      const payload = JSON.stringify(frame);
      let delivered = 0;
      for (const socket of this.ctx.getWebSockets()) {
        safeSend(socket, payload);
        delivered += 1;
      }
      return jsonResponse({ delivered });
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

  /** Create exactly one participant identity; retries never replace its role or KYC record. */
  private async onboard(command: ParticipantOnboarded): Promise<Response> {
    if (this.participant) {
      return jsonResponse({ error: "participant-exists", message: "participant onboarding has already been recorded" }, 409);
    }

    // Only this participant's object waits on the verifier. Shape checks are
    // preverification only in explicit staging; real KYC remains pending.
    const kycStatus = await devIdentityVerifier.verify({
      participantId: command.participantId,
      idDocumentType: command.idDocumentType,
      idDocument: command.idDocument,
    }, this.env.ALLOW_HEADER_AUTH === "true");

    const participant: Participant = {
      id: command.participantId,
      role: command.role,
      displayName: command.displayName,
      email: command.email,
      kycStatus,
      idDocumentType: command.idDocumentType,
      idDocumentHash: await hashIdDocument(
        command.idDocument,
        this.env.ID_DOCUMENT_HMAC_SECRET ?? "market-runs-dev-document-hmac-key",
      ),
      consentAt: command.consentAt,
      consentVersion: command.consentVersion,
      markets: [command.market],
      createdAt: Date.now(),
    };
    await this.ctx.storage.put(STATE_KEY, participant);
    this.participant = participant;

    const event: ServerEvent = { type: "participant.recorded", participant };
    broadcast(this.ctx, this.env,event);
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
    broadcast(this.ctx, this.env,event);
    return jsonResponse(event);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    handleWebSocketMessage(ws, message);
    this.telemetry.beat(this.env, this.ctx.id.name ?? "unknown", undefined, true);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    handleWebSocketClose(ws, code, reason);
    this.telemetry.beat(this.env, this.ctx.id.name ?? "unknown", undefined, true);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    handleWebSocketError(ws);
  }
}
