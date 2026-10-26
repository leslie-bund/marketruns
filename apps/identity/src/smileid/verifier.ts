import type { AsyncFaceVerifier, FaceCallbackVerdict, FaceJobSubmissionInput, FaceJobVerdict } from "../face-verifier.js";
import type { SmileIdClient, SmileIdJobStatus } from "./client.js";

/** Smile ID is quarantined to KYC + providerRef. Login always uses our local 1:1 verifier. */
export class SmileIdFaceVerifier implements AsyncFaceVerifier {
  readonly modelVersion = "smileid-biometric-kyc-v3";
  readonly asyncJobs = true as const;
  readonly callbackProvider = "smileid";
  constructor(private readonly client: SmileIdClient) {}
  async submitEnrollment(input: FaceJobSubmissionInput): Promise<{ providerJobId: string }> {
    if (!input.identityDocument) throw new Error("Biometric KYC requires BVN/NIN details");
    const accepted = await this.client.verifyIdDocument({
      userId: input.participantId, selfie: input.selfie, livenessImages: input.livenessImages,
      userDetails: input.userDetails ?? splitName("Market Runs"), country: input.identityDocument.country,
      idType: input.identityDocument.idType, idNumber: input.identityDocument.idNumber,
      consent: input.consent,
    });
    return { providerJobId: accepted.jobId };
  }
  async pollJob(id: string): Promise<FaceJobVerdict> {
    const result = await this.client.getJobStatus(id);
    return verdictFromStatus(result.status, result.message, result.verifiedLegalName);
  }
  async handleCallback(request: Request): Promise<FaceCallbackVerdict | null> {
    const payload = await this.client.parseCallback(request); if (!payload) return null;
    const verdict = verdictFromStatus(payload.status, payload.message, payload.verifiedLegalName);
    return { providerJobId: payload.providerJobId, userRef: payload.userId, passed: verdict.outcome === "passed",
      reason: verdict.outcome === "failed" ? (payload.reason ?? verdict.reason) : null,
      verifiedLegalName: payload.verifiedLegalName };
  }
}
function splitName(name: string) { const [givenNames, ...rest] = name.split(" "); return { givenNames: givenNames ?? "Market", lastName: rest.join(" ") || "Participant" }; }
function verdictFromStatus(status: SmileIdJobStatus, message: string, verifiedLegalName: string | null = null): FaceJobVerdict {
  if (status === "clear") return { outcome: "passed", verifiedLegalName };
  if (status === "processing" || status === "not_found") return { outcome: "pending" };
  return { outcome: "failed", reason: message || status };
}
