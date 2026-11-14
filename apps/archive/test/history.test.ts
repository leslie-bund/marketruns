import { describe, expect, it } from "vitest";
import { parseParticipantHistoryQuery } from "../src/history.js";

describe("participant history query", () => {
  it("requires an explicit edge-scoped participant and role", () => {
    expect(parseParticipantHistoryQuery(new URL("https://x/participant/history"))).toBeInstanceOf(Response);
    expect(parseParticipantHistoryQuery(new URL("https://x/participant/history?participantId=buyer-1&role=admin"))).toBeInstanceOf(Response);
    expect(parseParticipantHistoryQuery(new URL("https://x/participant/history?participantId=buyer-1&role=buyer"))).toEqual({ participantId: "buyer-1", role: "buyer" });
  });
});
