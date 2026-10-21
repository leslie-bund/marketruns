import { eq, or } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";

/** The archive consumer always runs inside db.transaction(...). */
export type ArchiveTx = PgTransaction<any, any, any>;
import { computeReputation, type Reputation, type ReputationFact, type ReputationRole } from "@market-runs/domain";
import { runsArchive, settlementRecords } from "../../../infra/drizzle/schema.js";

/**
 * Reputation read path (GLOSSARY.md): computed at query time from the durable
 * record — runs_archive + settlement_records.inputs. No user-entered ratings
 * exist anywhere in the system; the facts below are the ONLY inputs to the
 * domain reputation function.
 */

interface RunFactRow {
  runId: string;
  /** Settlement mode when released; NULL while disputed/unreleased. */
  mode: string | null;
  /** runs_archive status fallback when no settlement row exists yet. */
  status: string;
}

/** Buyer and runner facts: one per run they participated in. */
export async function loadParticipantRunFacts(
  tx: ArchiveTx,
  participantId: string,
  role: Extract<ReputationRole, "buyer" | "runner">,
): Promise<RunFactRow[]> {
  const column = role === "buyer" ? runsArchive.buyerId : runsArchive.runnerId;
  const rows = await tx
    .select({
      runId: runsArchive.id,
      mode: settlementRecords.mode,
      status: runsArchive.status,
    })
    .from(runsArchive)
    .leftJoin(settlementRecords, eq(settlementRecords.runId, runsArchive.id))
    .where(eq(column, participantId));
  return rows;
}

interface SellerFactRow {
  runId: string;
  mode: string;
  stopCompleted: boolean;
}

/** Seller facts: one per settlement leg naming this seller. */
export async function loadSellerRunFacts(tx: ArchiveTx, participantId: string): Promise<SellerFactRow[]> {
  const rows = await tx
    .select({ runId: settlementRecords.runId, mode: settlementRecords.mode, inputs: settlementRecords.inputs })
    .from(settlementRecords);
  const facts: SellerFactRow[] = [];
  for (const row of rows) {
    for (const seller of row.inputs?.sellers ?? []) {
      if (seller.sellerId !== participantId) continue;
      facts.push({ runId: row.runId, mode: row.mode, stopCompleted: seller.stopCompleted });
    }
  }
  return facts;
}

function modeOf(row: RunFactRow): ReputationFact["mode"] {
  if (row.mode === "completed" || row.mode === "aborted" || row.mode === "disputed") return row.mode;
  return row.status === "aborted" ? "aborted" : "completed";
}

export function factsFromRunRows(rows: RunFactRow[], role: Extract<ReputationRole, "buyer" | "runner">): ReputationFact[] {
  return rows.map((row) => ({ runId: row.runId, mode: modeOf(row), role }));
}

export function factsFromSellerRows(rows: SellerFactRow[]): ReputationFact[] {
  return rows.map((row) => ({
    runId: row.runId,
    mode: row.mode as ReputationFact["mode"],
    role: "seller",
    stopCompleted: row.stopCompleted,
  }));
}

/** Compute a participant's standing from the durable record. */
export async function loadReputation(
  tx: ArchiveTx,
  participantId: string,
  role: ReputationRole,
): Promise<Reputation> {
  let facts: ReputationFact[];
  if (role === "seller") {
    facts = factsFromSellerRows(await loadSellerRunFacts(tx, participantId));
  } else {
    facts = factsFromRunRows(await loadParticipantRunFacts(tx, participantId, role), role);
  }
  return computeReputation(participantId, facts);
}

/** Query params shared by the HTTP endpoint and callers. */
export function parseReputationQuery(url: URL): { participantId: string; role: ReputationRole } | Response {
  const participantId = url.searchParams.get("participant");
  const role = url.searchParams.get("role") ?? "buyer";
  if (!participantId) {
    return Response.json({ error: "invalid-query", message: "participant query param is required" }, { status: 400 });
  }
  if (role !== "buyer" && role !== "runner" && role !== "seller") {
    return Response.json({ error: "invalid-query", message: "role must be buyer | runner | seller" }, { status: 400 });
  }
  return { participantId, role };
}
