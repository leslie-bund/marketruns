import type { AsyncFaceVerifier, FaceCallbackVerdict, FaceJobSubmissionInput, FaceJobVerdict } from "../face-verifier.js";
import type { SmileIdClient, SmileIdJobStatus } from "./client.js";

/**
 * The Smile ID implementation of the async face-verifier seam. The biometric
 * reference is VENDOR-HELD (ADR-0022 records the tradeoff): no vendor returns
 * raw embeddings, so enrollment registers a provider-side reference keyed by
 * participantId (user_id) and verification delegates to SmartSelfie™
 * Authentication. Our face_enrollments row records providerRef +
 * modelVersion="smileid-smartselfie-v3" and its embedding columns stay NULL.
 *
 * Fallbacks, honestly labelled: when the wire carries no liveness frames the
 * client repeats the selfie (sandbox-adequate, production-liveness fails);
 * when no userDetails arrive the caller substitutes a placeholder — production
 * rollout requires the edge to forward real consent + PII at enrollment.
 */
export class SmileIdFaceVerifier implements AsyncFaceVerifier {
  readonly modelVersion = "smileid-smartselfie-v3";
  readonly asyncJobs = true as const;
  readonly callbackProvider = "smileid";

  constructor(private readonly client: SmileIdClient) {}

  async submitEnrollment(input: FaceJobSubmissionInput): Promise<{ providerJobId: string }> {
    const accepted = await this.client.submitRegistration(toVendorInput(input));
    return { providerJobId: accepted.jobId };
  }

  async submitAuthentication(input: FaceJobSubmissionInput): Promise<{ providerJobId: string }> {
    const accepted = await this.client.submitAuthentication(toVendorInput(input));
    return { providerJobId: accepted.jobId };
  }

  async pollJob(providerJobId: string): Promise<FaceJobVerdict> {
    const { status, message } = await this.client.getJobStatus(providerJobId);
    return verdictFromStatus(status, message);
  }

  async handleCallback(request: Request): Promise<FaceCallbackVerdict | null> {
    const payload = await this.client.parseCallback(request);
    if (!payload) return null;
    const verdict = verdictFromStatus(payload.status, payload.message);
    return {
      providerJobId: payload.providerJobId,
      userRef: payload.userId,
      passed: verdict.outcome === "passed",
      reason: verdict.outcome === "failed" ? (payload.reason ?? verdict.reason) : null,
    };
  }
}

/** Vendor statuses → our verdict: only "clear" passes; every other terminal state fails. */
function verdictFromStatus(status: SmileIdJobStatus, message: string): FaceJobVerdict {
  if (status === "clear") return { outcome: "passed" };
  if (status === "processing" || status === "not_found") return { outcome: "pending" };
  return { outcome: "failed", reason: message || status };
}

function toVendorInput(input: FaceJobSubmissionInput) {
  return {
    userId: input.participantId,
    selfie: input.selfie,
    livenessImages: input.livenessImages,
    allowNewEnroll: input.allowNewEnroll,
    // Placeholder PII when the edge didn't forward any (dev-stage; the vendor
    // requires consumer-stated details on every job). Production rollout must
    // pass real userDetails through the internal enroll seam.
    userDetails: input.userDetails ?? {
      givenNames: "MarketRuns",
      lastName: `Participant ${input.participantId}`,
      email: `participant-${input.participantId}@placeholder.market-runs.invalid`,
    },
  };
}
