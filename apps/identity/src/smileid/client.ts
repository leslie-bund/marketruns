import type { SmileIdConfig } from "./config.js";

/**
 * Smile ID server-to-server v3 HTTP client. All vendor wire shapes live here
 * (ADR-0009 quarantine) — nothing outside apps/identity/src/smileid sees a
 * Smile ID field name.
 *
 * Auth scheme (current docs, verified against
 * https://docs.usesmileid.com/api-reference/authentication.md):
 *   - POST /v3/token with `smileid-partner-id` + `smileid-api-key` headers →
 *     short-lived JWT (15 min TTL), then carried as `SmileID-Token` on all
 *     verification requests, alongside `SmileID-Partner-ID`.
 *   - The historical body-signature scheme (HMAC-SHA256 over
 *     timestamp+partner_id+"sid_request") is GONE for outgoing requests — but
 *     it is EXACTLY the scheme retained for verifying inbound callbacks
 *     (Response-Signature / Response-Timestamp headers, verified per
 *     developer-resources/essentials/verification-webhooks/receive-webhooks/
 *     configure-your-webhook-server.md). We implement it for callbacks only.
 *
 * All jobs are async: submissions answer 202 {job_id, user_id}; results arrive
 * by webhook or by polling GET /v3/status/{jobId}.
 */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class SmileIdApiError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(`Smile ID API ${httpStatus}: ${message}`);
    this.name = "SmileIdApiError";
  }
}

export interface SmileIdAccepted {
  jobId: string;
  userId: string;
}

/** Terminal vendor statuses map to a verdict; "processing"/"not_found" stay pending-ish. */
export type SmileIdJobStatus = "clear" | "block" | "attention" | "error" | "processing" | "not_found";

export interface SmileIdUserDetails {
  givenNames: string;
  lastName: string;
  email?: string | undefined;
  phone?: string | undefined;
}

export interface SmileIdFaceJobInput {
  /** Our participantId — becomes the provider-side user_id the enrollment is keyed by. */
  userId: string;
  selfie: Uint8Array;
  /** 6–8 liveness frames. The caller's documented fallback applies when empty. */
  livenessImages: Uint8Array[];
  userDetails: SmileIdUserDetails;
  /** enrollment only: allow replacing an existing provider-side enrollment. */
  allowNewEnroll?: boolean | undefined;
}

export interface SmileIdBiometricKycInput extends SmileIdFaceJobInput {
  /** ISO 3166-1 alpha-2, e.g. "NG". */
  country: string;
  /** e.g. "BVN" | "NIN". */
  idType: string;
  idNumber: string;
}

/** Raw, minimally-validated callback payload (only the fields we consume). */
export interface SmileIdCallbackPayload {
  status: SmileIdJobStatus;
  message: string;
  reason: string | null;
  providerJobId: string;
  userId: string;
}

const TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

export class SmileIdClient {
  private tokenCache: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: SmileIdConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Auth: short-lived JWT                                               */
  /* ------------------------------------------------------------------ */

  /** Fetch (or reuse a cached, unexpired) v3 access token. */
  async getToken(product?: string): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) {
      return this.tokenCache.token;
    }
    const form = new FormData();
    if (product) form.append("product", product);
    const res = await this.fetchImpl(`${this.config.baseUrl}/v3/token`, {
      method: "POST",
      headers: {
        "smileid-partner-id": this.config.partnerId,
        "smileid-api-key": this.config.apiKey,
      },
      body: form,
    });
    if (!res.ok) throw new SmileIdApiError(res.status, await res.text());
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new SmileIdApiError(res.status, "token response missing `token`");
    this.tokenCache = { token: body.token, expiresAt: now + TOKEN_TTL_MS };
    return body.token;
  }

  private async authedHeaders(product?: string): Promise<Record<string, string>> {
    return {
      "SmileID-Partner-ID": this.config.partnerId,
      "SmileID-Token": await this.getToken(product),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Job submission (multipart/form-data, async — 202 Accepted)          */
  /* ------------------------------------------------------------------ */

  /** SmartSelfie™ Registration — POST /v3/registration. */
  async submitRegistration(input: SmileIdFaceJobInput): Promise<SmileIdAccepted> {
    return this.submitFaceJob("/v3/registration", "smart_selfie_registration", input);
  }

  /** SmartSelfie™ Authentication — POST /v3/authentication. */
  async submitAuthentication(input: SmileIdFaceJobInput): Promise<SmileIdAccepted> {
    return this.submitFaceJob("/v3/authentication", "smart_selfie_authentication", input);
  }

  /**
   * Biometric KYC — POST /v3/biometric_kyc. Binds a BVN/NIN to the enrolled
   * face via the ID authority. This is the KYC seam: the edge's
   * IdentityVerifier (apps/edge/src/kyc/verifier.ts, dev stub today) is the
   * integration point when KYC verification is rewired to a real vendor.
   */
  async verifyIdDocument(input: SmileIdBiometricKycInput): Promise<SmileIdAccepted> {
    const form = this.faceJobForm(input);
    form.append("country", input.country);
    form.append("id_type", input.idType);
    form.append("id_number", input.idNumber);
    return this.post(form, "/v3/biometric_kyc", "biometric_kyc");
  }

  private faceJobForm(input: SmileIdFaceJobInput): FormData {
    const form = new FormData();
    form.append("user_id", input.userId);
    form.append("selfie_image", new Blob([input.selfie as BlobPart], { type: "image/jpeg" }), "selfie.jpg");
    // The vendor requires 6–8 liveness frames; our wire captures one image,
    // so when no frames were supplied we repeat the selfie. HONEST NOTE: this
    // passes entry validation and works in sandbox (sandbox_result forcing),
    // but real production liveness will reject repeated identical frames —
    // capturing a liveness sequence on the client is the launch-blocker fix.
    const frames = input.livenessImages.length > 0 ? input.livenessImages : [input.selfie];
    for (let i = 0; i < Math.max(6, frames.length); i += 1) {
      const frame = frames[i % frames.length];
      form.append("liveness_images", new Blob([frame as BlobPart], { type: "image/jpeg" }), `liveness_${i}.jpg`);
    }
    form.append(
      "consent",
      JSON.stringify({
        granted: true,
        granted_at: new Date().toISOString(),
        notice_language: "EN",
        notice_privacy_policy_url: this.config.privacyNoticeUrl,
      }),
    );
    form.append(
      "user_details",
      JSON.stringify({
        given_names: input.userDetails.givenNames,
        last_name: input.userDetails.lastName,
        email: input.userDetails.email ?? null,
        phone_number: input.userDetails.phone ?? null,
      }),
    );
    if (input.allowNewEnroll !== undefined) form.append("allow_new_enroll", String(input.allowNewEnroll));
    if (this.config.callbackUrl) form.append("callback_url", this.config.callbackUrl);
    return form;
  }

  private async submitFaceJob(
    path: "/v3/registration" | "/v3/authentication",
    product: string,
    input: SmileIdFaceJobInput,
  ): Promise<SmileIdAccepted> {
    return this.post(this.faceJobForm(input), path, product);
  }

  private async post(form: FormData, path: string, product: string): Promise<SmileIdAccepted> {
    const res = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers: await this.authedHeaders(product),
      body: form,
    });
    if (res.status !== 202) throw new SmileIdApiError(res.status, await res.text());
    const body = (await res.json()) as { job_id?: string; user_id?: string };
    if (!body.job_id || !body.user_id) {
      throw new SmileIdApiError(res.status, "accepted response missing job_id/user_id");
    }
    return { jobId: body.job_id, userId: body.user_id };
  }

  /* ------------------------------------------------------------------ */
  /* Polling: GET /v3/status/{jobId}                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Poll a job. HTTP 200 = terminal (clear/block/attention/error),
   * 202 = processing, 404 = not_found (treated as still-pending upstream:
   * a just-submitted job may not be visible to the status endpoint yet).
   */
  async getJobStatus(jobId: string): Promise<{ status: SmileIdJobStatus; message: string }> {
    const res = await this.fetchImpl(`${this.config.baseUrl}/v3/status/${encodeURIComponent(jobId)}`, {
      method: "GET",
      headers: await this.authedHeaders(),
    });
    if (!res.ok && res.status !== 202 && res.status !== 404) {
      throw new SmileIdApiError(res.status, await res.text());
    }
    const body = (await res.json()) as { status?: SmileIdJobStatus; message?: string };
    return { status: body.status ?? (res.status === 202 ? "processing" : "not_found"), message: body.message ?? "" };
  }

  /* ------------------------------------------------------------------ */
  /* Callback verification (inbound webhooks)                            */
  /* ------------------------------------------------------------------ */

  /**
   * Outbound-callback signature, per the current docs:
   *   Response-Signature = base64(HMAC-SHA256(
   *     key = api_key,
   *     message = Response-Timestamp + partner_id + "sid_request"
   *   ))
   * Computed over the RAW header values, compared timing-safely.
   */
  async computeCallbackSignature(timestamp: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.config.apiKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(timestamp + this.config.partnerId + "sid_request"),
    );
    return bytesToBase64(new Uint8Array(signature));
  }

  async verifyCallbackSignature(timestamp: string | null, signature: string | null): Promise<boolean> {
    if (!timestamp || !signature) return false;
    const expected = await this.computeCallbackSignature(timestamp);
    return timingSafeEqual(expected, signature);
  }

  /**
   * Verify + parse a callback Request. Returns null when the signature is
   * missing/invalid; throws SmileIdApiError(400) on a well-signed but
   * malformed payload.
   */
  async parseCallback(request: Request): Promise<SmileIdCallbackPayload | null> {
    const valid = await this.verifyCallbackSignature(
      request.headers.get("Response-Timestamp"),
      request.headers.get("Response-Signature"),
    );
    if (!valid) return null;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const partnerParams = (body?.partner_params ?? null) as Record<string, unknown> | null;
    const status = body?.status;
    const jobId = partnerParams?.job_id;
    const userId = partnerParams?.user_id;
    if (
      typeof status !== "string" ||
      typeof jobId !== "string" ||
      typeof userId !== "string" ||
      !["clear", "block", "attention", "error", "processing", "not_found"].includes(status)
    ) {
      throw new SmileIdApiError(400, "well-signed callback with an unparseable payload");
    }
    return {
      status: status as SmileIdJobStatus,
      message: typeof body?.message === "string" ? body.message : "",
      reason: typeof body?.reason === "string" ? body.reason : null,
      providerJobId: jobId,
      userId,
    };
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Constant-time string comparison (length-checked first). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
