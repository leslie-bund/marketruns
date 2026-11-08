import { describe, expect, it } from "vitest";
import {
  PaymentRefundResolutionRequestSchema,
  PaymentRefundResolutionSchema,
  PaymentRefundViewSchema,
} from "../src/index.js";

const accept = {
  action: "accept-provider",
  status: "processing",
  providerRef: "provider-refund-1",
  evidenceRef: "evidence/refund-1.json",
  note: "Provider history confirms one accepted refund.",
} as const;

const manual = {
  action: "complete-manual",
  providerRef: "manual-transfer-1",
  evidenceRef: "evidence/manual-1.json",
  note: "Manual transfer receipt verified.",
} as const;

const retry = {
  action: "allow-retry",
  evidenceRef: "evidence/retry-1.json",
  note: "Provider confirmed no accepted refund exists.",
} as const;

describe("payment refund resolution schemas", () => {
  it("round-trips every discriminated resolution action", () => {
    for (const resolution of [accept, manual, retry]) {
      const parsed = PaymentRefundResolutionRequestSchema.parse({ resolvedBy: "ops:ada", resolution });
      expect(parsed.resolution).toEqual(resolution);
    }
  });

  it("accepts provider completion and trims all trusted audit text", () => {
    const parsed = PaymentRefundResolutionRequestSchema.parse({
      resolvedBy: "  ops:ada  ",
      resolution: {
        ...accept,
        status: "completed",
        providerRef: "  provider-refund-2  ",
        evidenceRef: "  evidence/refund-2.json  ",
        note: "  Completed at the provider.  ",
      },
    });
    expect(parsed).toEqual({
      resolvedBy: "ops:ada",
      resolution: {
        ...accept,
        status: "completed",
        providerRef: "provider-refund-2",
        evidenceRef: "evidence/refund-2.json",
        note: "Completed at the provider.",
      },
    });
  });

  it("rejects invalid action/status combinations and empty fields", () => {
    expect(PaymentRefundResolutionSchema.safeParse({ ...accept, status: "failed" }).success).toBe(false);
    expect(PaymentRefundResolutionSchema.safeParse({ ...accept, status: "pending" }).success).toBe(false);
    expect(PaymentRefundResolutionSchema.safeParse({ ...retry, providerRef: "not-allowed" }).success).toBe(false);
    expect(PaymentRefundResolutionSchema.safeParse({ ...manual, providerRef: "   " }).success).toBe(false);
    expect(PaymentRefundResolutionRequestSchema.safeParse({ resolvedBy: " ", resolution: retry }).success).toBe(false);
    expect(PaymentRefundResolutionRequestSchema.safeParse({ resolvedBy: "ops:ada" }).success).toBe(false);
  });

  it.each([
    "amountKobo",
    "legs",
    "runId",
    "idempotencyKey",
    "resolvedBy",
    "resolvedAt",
  ])("rejects spoofed or money-bearing resolution field %s", (field) => {
    const body = {
      resolvedBy: "ops:ada",
      resolution: { ...accept, [field]: field === "amountKobo" ? 1 : "spoofed" },
    };
    expect(PaymentRefundResolutionRequestSchema.safeParse(body).success).toBe(false);
  });

  it("strictly rejects unknown keys at both request levels and over-bound text", () => {
    expect(PaymentRefundResolutionRequestSchema.safeParse({
      resolvedBy: "ops:ada",
      resolvedAt: 1_800_000_000_000,
      resolution: accept,
    }).success).toBe(false);
    expect(PaymentRefundResolutionRequestSchema.safeParse({
      resolvedBy: "ops:ada",
      resolution: { ...retry, unexpected: true },
    }).success).toBe(false);
    expect(PaymentRefundResolutionRequestSchema.safeParse({
      resolvedBy: "ops:ada",
      resolution: { ...retry, note: "x".repeat(2_001) },
    }).success).toBe(false);
    expect(PaymentRefundResolutionRequestSchema.safeParse({
      resolvedBy: "ops:ada",
      resolution: { ...retry, evidenceRef: "x".repeat(2_049) },
    }).success).toBe(false);
  });

  it("adds a nullable audited resolution to refund views", () => {
    const view = {
      id: "refund:settlement-1",
      holdId: "hold:1",
      settlementRecordId: "settlement-1",
      amountKobo: 100_000,
      status: "processing",
      providerRef: "provider-refund-1",
      failureReason: null,
      attempts: 2,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_100,
      resolution: {
        ...accept,
        resolvedBy: "ops:ada",
        resolvedAt: 1_800_000_000_100,
      },
    };
    expect(PaymentRefundViewSchema.parse(view).resolution?.evidenceRef).toBe("evidence/refund-1.json");
    expect(PaymentRefundViewSchema.parse({ ...view, resolution: null }).resolution).toBeNull();
  });
});
