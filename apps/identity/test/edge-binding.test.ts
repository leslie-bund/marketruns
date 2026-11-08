import { describe, expect, it } from "vitest";
import { reconcileCoreKyc } from "../src/app.js";
import type { Env } from "../src/env.js";

describe("identity to edge service binding", () => {
  it("reconciles verified KYC through the binding", async () => {
    let seenUrl = "";
    let seenToken: string | null = null;
    const service = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        seenUrl = String(input);
        seenToken = new Headers(init?.headers).get("x-identity-internal");
        return Response.json({ type: "participant.recorded", participant: {
          id: "p-1", role: "buyer", displayName: "Amina", verifiedLegalName: "Amina Yusuf", kycStatus: "verified",
          idDocumentType: "bvn", idDocumentHash: "hash", markets: ["Balogun"], createdAt: Date.now(),
        } });
      },
    } as unknown as Fetcher;
    const env = {
      EDGE_URL: "https://edge.marketruns.test", EDGE_SERVICE: service, IDENTITY_INTERNAL_TOKEN: "shared-test-token",
    } satisfies Partial<Env>;
    await reconcileCoreKyc(env, { participantId: "p-1", verifiedLegalName: "Amina Yusuf" });
    expect(seenUrl).toBe("https://edge.marketruns.test/internal/identity/kyc");
    expect(seenToken).toBe("shared-test-token");
  });
});
