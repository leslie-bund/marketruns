const PREFIX = "market-runs:handoff:v1:";

export interface HandoffPayload { runId: string; handoffId: string; challenge: string }

export function createHandoffPayload(payload: HandoffPayload): string {
  return `${PREFIX}${encodeURIComponent(JSON.stringify(payload))}`;
}

export function parseHandoffPayload(value: string): HandoffPayload | null {
  if (!value.startsWith(PREFIX)) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value.slice(PREFIX.length))) as Partial<HandoffPayload>;
    if (!parsed.runId || !parsed.handoffId || !parsed.challenge) return null;
    return { runId: parsed.runId, handoffId: parsed.handoffId, challenge: parsed.challenge };
  } catch {
    return null;
  }
}
