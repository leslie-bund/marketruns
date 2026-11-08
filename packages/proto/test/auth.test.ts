import { describe, expect, it } from "vitest";
import { IdentityKycRequestSchema, IdentityKycResponseSchema, ParticipantRecordedSchema } from "../src/index.js";

describe("identity KYC reconciliation contracts", () => {
  it("accepts exactly a participant id and a nullable verified legal name", () => {
    expect(IdentityKycRequestSchema.parse({ participantId: "participant-1", verifiedLegalName: "Amina Yusuf" })).toEqual({
      participantId: "participant-1",
      verifiedLegalName: "Amina Yusuf",
    });
    expect(IdentityKycRequestSchema.parse({ participantId: "participant-1", verifiedLegalName: null })).toEqual({
      participantId: "participant-1",
      verifiedLegalName: null,
    });
    expect(IdentityKycRequestSchema.safeParse({ participantId: "participant-1" }).success).toBe(false);
    expect(IdentityKycRequestSchema.safeParse({
      participantId: "participant-1",
      verifiedLegalName: null,
      kycStatus: "verified",
    }).success).toBe(false);
  });

  it("returns the existing ParticipantRecorded wire shape", () => {
    expect(IdentityKycResponseSchema).toBe(ParticipantRecordedSchema);
  });
});
