import { RunSchema, type Run } from "@market-runs/proto";
import type { Env } from "../config/env.js";
import { errorResponse } from "../do/runtime/index.js";
import { coreRegistry } from "../registry/index.js";
import type { Participant } from "./middleware/participant.js";

export type RunAccess = { run: Run } | { denied: Response };

/** Central participant-membership check for run reads, disputes, evidence, and scoped secrets. */
export async function runForParticipant(env: Env, runId: string, who: Participant): Promise<RunAccess> {
  if (who.source === "unauthenticated") return { denied: errorResponse(401, "unauthorized", "a Bearer session is required") };
  const response = await env.RUN_DO.get(env.RUN_DO.idFromName(runId)).fetch(new Request("http://do/"));
  if (!response.ok) return { denied: response };
  const parsed = RunSchema.safeParse(await response.clone().json().then((body) => (body as { run?: unknown }).run));
  if (!parsed.success) return { denied: errorResponse(502, "bad-run-response", "run read returned an invalid projection") };
  const run = parsed.data;
  if (who.source === "anonymous") {
    return run.buyerId === "buyer:anonymous" ? { run } : { denied: errorResponse(401, "unauthorized", "a participant identity is required") };
  }

  let member = false;
  if (who.role === "buyer") member = run.buyerId === who.id;
  else if (who.role === "runner") {
    member = run.runnerId === who.id || (!run.runnerId && await coreRegistry(env).isInternalRunner(run.market, who.id));
  } else if (who.role === "seller") {
    member = run.sellerParticipantIds?.includes(who.id) === true || run.stops.some((stop) => stop.sellerParticipantId === who.id);
  }
  return member ? { run } : { denied: errorResponse(403, "forbidden", "participant is not a member of this run") };
}
