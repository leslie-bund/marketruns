import { describe, expect, it, vi } from "vitest";
import type { Notification } from "@market-runs/proto";
import { createProviders } from "../src/provider.js";

function notification(): Notification {
  return {
    id: "notification:1",
    recipientId: "buyer:contact-contract",
    sourceEventId: "payment.hold-placed:hold:1",
    sourceEventType: "payment.hold-placed",
    dedupeKey: "payment.hold-placed:hold:1:buyer:contact-contract",
    category: "payment",
    title: "Payment receipt",
    body: "Your payment is held.",
    data: {},
    createdAt: 1000,
    readAt: null,
  };
}

describe("notification email contact contract", () => {
  it("looks up the recipient through the authenticated edge internal endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ email: "receipts@example.com" }))
      .mockResolvedValueOnce(Response.json({ id: "resend:1" }));
    const providers = createProviders({
      edgeUrl: "https://edge.example.com",
      edgeInternalToken: "shared-internal-token",
      resendApiKey: "resend-test-key",
      resendFromEmail: "receipts@market-runs.example.com",
      fetchImpl: fetcher,
    });

    expect(await providers.email(notification())).toEqual({ kind: "delivered", providerRef: "resend:1" });
    expect(fetcher).toHaveBeenNthCalledWith(1,
      "https://edge.example.com/internal/notification-contact/buyer%3Acontact-contract",
      { headers: { "x-notification-internal": "shared-internal-token" } },
    );
    expect(fetcher).toHaveBeenNthCalledWith(2, "https://api.resend.com/emails", expect.objectContaining({ method: "POST" }));
  });
});
