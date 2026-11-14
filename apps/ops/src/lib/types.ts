export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ListEnvelope<T> {
  items: T[];
  total: number;
  limit?: number;
  offset?: number;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface NamedGeoPoint extends GeoPoint {
  name: string;
}

export interface MarketConfig {
  closeAt: number;
  opsConfigured?: boolean;
  estTripMs: number;
  bufferMs: number;
  floorRate: {
    distanceMeters: number;
    estimatedDurationMs: number;
    baseKobo: number;
    perKilometerKobo: number;
    perMinuteKobo: number;
  };
  settlement: {
    goodsCommissionBps: number;
    deliveryMarginKobo: number;
  };
  geo?: {
    center: GeoPoint;
    radiusMeters: number;
    exchangePoints: NamedGeoPoint[];
    musterPoints: NamedGeoPoint[];
  };
}

export interface OpsMarket {
  id: string;
  name: string;
  opensAt: string;
  closesAt: string;
  active: boolean;
  config: MarketConfig | null;
  centerLatitude?: number | null;
  centerLongitude?: number | null;
  geofenceRadiusMeters?: number;
  createdAt?: string;
  updatedAt?: string;
}

export type RunStatus = "unassigned" | "assigned" | "collecting" | "delivering" | "delivered" | "closed" | "aborted";

export interface LiveRun {
  kind: "live";
  runId: string;
  market: string;
  status: RunStatus;
  runnerId: string | null;
  buyerId: string;
  startedAt: number;
  retiredAt: number | null;
  stopCount: number;
  storeIds: string[];
}

export interface ArchivedRun {
  kind: "archived";
  runId: string;
  cartId: string;
  market: string;
  buyerId: string;
  runnerId: string;
  status: RunStatus;
  floorRateKobo: number;
  startedAt: number | null;
  finalDeliveryAt: number | null;
  closedAt: number;
}

export type AdminRun = LiveRun | ArchivedRun;

export interface RunStop {
  sellerName: string;
  storeId?: string;
  sellerParticipantId?: string;
  exchangePoint: string;
  shopItems: string[];
  status: "next" | "upcoming" | "completed";
  legDistanceMeters?: number;
  legDurationSeconds?: number;
  location?: GeoPoint;
}

export interface RunHandoff {
  id: string;
  type: "pickup" | "delivery";
  exchangePoint: string;
  counterparty: string;
  status: "pending" | "confirmed";
  requestedAt: number;
  photoCaptureRef?: string;
  photoCapturedAt?: number;
  scannedAt?: number;
  confirmedAt?: number;
  confirmedBy?: string;
  autoConfirmed?: boolean;
  awaitingPhoto?: boolean;
  codeExpiresAt?: number;
}

export interface OpsRun {
  id: string;
  market: string;
  status: RunStatus;
  floorRateKobo: number;
  delivery: { kind: "plus-code"; plusCode: string } | { kind: "muster-point"; name: string };
  receiver?: { kind: "buyer" } | { kind: "designated"; name: string };
  stops: RunStop[];
  handoffs: RunHandoff[];
  buyerId?: string;
  runnerId?: string;
  sellerParticipantIds?: string[];
  disputed?: boolean;
  finalDeliveryAt?: number | null;
  route?: {
    distanceMeters: number;
    durationSeconds: number;
    destination?: GeoPoint;
    geometry?: GeoPoint[];
  };
}

export interface OpsRunDispute {
  reason: string;
  raisedByParticipantId: string | null;
  evidenceRefs: string[];
}

export interface OpsRunDetail {
  run: OpsRun | null;
  dispute?: OpsRunDispute | null;
}

export interface Dispute {
  id: string;
  runId: string;
  market: string;
  settlementRecordId: string | null;
  raisedByParticipantId: string;
  reason: string;
  evidenceRefs: string[];
  ambiguous: boolean;
  absorbedLossKobo: number;
  status: "open" | "under_review" | "resolved";
  createdAt: number;
  resolvedAt: number | null;
}

export interface Settlement {
  id: string;
  runId: string;
  market: string;
  mode: "completed" | "aborted" | "disputed";
  goodsTotalKobo: number;
  runnerKobo: number;
  platformKobo: number;
  buyerRefundKobo: number;
  platformLossKobo: number;
  releasedAt: number;
}

export interface LedgerEntry {
  id: string;
  settlementRecordId: string;
  runId: string;
  market: string;
  account: string;
  partyId: string | null;
  debitKobo: number;
  creditKobo: number;
  memo: string;
  createdAt: number;
}

export interface OpsHealth {
  market: string;
  consecutiveQualifyingWeeks: number;
  completedRuns: number;
  disputeRateBps: number;
  zeroTouchRateBps: number;
  repeatBuyers: number;
  gate: {
    qualifyingWeeks: GateMetric;
    completedRuns: GateMetric;
    disputeRateBps: GateMetric;
    zeroTouchRateBps: GateMetric;
    repeatBuyers: GateMetric;
    pass: boolean;
  };
  computedAt: number;
}

export interface GateMetric {
  threshold: number;
  pass: boolean;
}

export interface PaymentDispatch {
  id: string;
  idempotencyKey: string;
  settlementRecordId: string;
  runId: string;
  market: string;
  account: string;
  partyId: string;
  amountKobo: number;
  memo: string;
  status: "pending" | "sent" | "queued" | "failed" | "completed";
  providerRef: string | null;
  failureReason: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface PaymentHold {
  id: string;
  txRef: string;
  providerTxId: string;
  cartId: string;
  runId: string | null;
  buyerId: string;
  amountKobo: number;
  paymentMethod: string;
  status: "held" | "released" | "partially-refunded" | "refunded" | "failed";
  createdAt: number;
  updatedAt: number;
}

export interface RefundResolution {
  action: "accept-provider" | "complete-manual" | "allow-retry";
  status: "processing" | "completed" | "failed";
  providerRef: string | null;
  evidenceRef: string;
  note: string;
  resolvedBy: string;
  resolvedAt: number;
}

export interface PaymentRefund {
  id: string;
  holdId: string;
  settlementRecordId: string;
  amountKobo: number;
  status: "pending" | "processing" | "completed" | "failed" | "refund-review" | "refund-manual";
  providerRef: string | null;
  failureReason: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  resolution: RefundResolution | null;
}

export interface RecoveryIssue {
  kind: "dispatch" | "refund" | "hold" | "missing";
  id: string;
  status: string;
  amountKobo: number | null;
  updatedAt: number;
}

export interface RecoveryAction {
  type: "replay-dispatch" | "sync-dispatch" | "resolve-refund" | "redrive-settlement";
  targetId: string;
}

export interface RecoveryItem {
  settlementRecordId: string;
  runId: string;
  market: string;
  buyerId: string;
  runnerId: string;
  issues: RecoveryIssue[];
  actions: RecoveryAction[];
}

export interface ShopItem {
  id: string;
  storeId: string;
  name: string;
  attributes: Record<string, unknown>;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface OpsStore {
  id: string;
  sellerParticipantId: string;
  marketId: string;
  name: string;
  exchangePoint: string;
  joinedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  shopItems: ShopItem[];
}

export interface RunnerPoolMember {
  poolId: string;
  runnerId: string;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface RunnerPool {
  id: string;
  marketId: string;
  name: string;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
  members: RunnerPoolMember[];
}

export interface AuditEvent {
  id: string;
  operatorId: string;
  operatorEmail: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  requestId: string | null;
  outcome: "applied" | "rejected" | string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface TelemetryItem {
  objectName: string;
  instanceId: string;
  objectClass: "MarketDO" | "ProductDO" | "CartDO" | "RunDO" | "ParticipantDO";
  market: string | null;
  connectionCount: number;
  connections: unknown[];
  lastActivityAt: string;
  alarmAt: string | null;
  reportedAt: string;
  live: boolean;
}

export interface DeviceReset {
  id: string;
  participantId: string;
  status: "pending" | "approved" | "rejected";
  reason: string;
  resolvedBy: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface ParticipantProfile {
  participantId?: string;
  displayName?: string;
  role?: string;
  kycStatus?: string;
  markets?: string[];
  [key: string]: unknown;
}

export interface ParticipantInvolvement {
  participant: { participant?: ParticipantProfile } | ParticipantProfile | null;
  involvements: null | {
    stores: OpsStore[];
    pools: Array<{ pool: RunnerPool; membership: RunnerPoolMember }>;
    markets: string[];
    runs: { live: unknown[]; historical: unknown[] };
    rooms: unknown[];
  };
}

export interface Reputation {
  participantId?: string;
  completedRuns?: number;
  completedTrips?: number;
  abortedTrips?: number;
  disputedTrips?: number;
  strikes?: number;
  abortRateBps?: number;
  disputeRateBps?: number;
  standingBps?: number;
  [key: string]: unknown;
}


export type ArchiveQueueStatus = "received" | "persisted" | "retrying" | "rejected";

export interface ArchiveQueueMessage {
  id: string;
  eventType: string;
  status: ArchiveQueueStatus;
  attempts: number;
  requestId: string | null;
  error: string | null;
  firstReceivedAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface ArchiveQueueResponse extends ListEnvelope<ArchiveQueueMessage> {
  limit: number;
  offset: number;
  summary: Record<ArchiveQueueStatus, number> & { oldestUnresolvedAt: number | null };
}
