import { describe, expect, it } from "vitest";
import type { DispatchTransferRequest } from "../src/dispatcher.js";
import {
  FlutterwaveDispatcher,
  PROVIDER_REF_PREFIX,
  TEST_MODE_FAILURE_SUFFIX,
  TEST_MODE_SUCCESS_SUFFIX,
  inboundReference,
  mapProviderTransfer,
  outboundReference,
} from "../src/flutterwave/dispatcher.js";
import { flutterwaveConfig } from "../src/flutterwave/config.js";
import { createVendorIntegration } from "../src/flutterwave/index.js";
import { DevRecipientResolver } from "../src/flutterwave/recipients.js";
import { parseTransferWebhook, verifyWebhookHash } from "../src/flutterwave/webhook.js";
import type { FlutterwaveConfig } from "../src/flutterwave/config.js";

/**
 * Flutterwave quarantine tests. fetch is ALWAYS mocked — these tests never
 * touch the real API. Response shapes mirror the v3 docs' own examples
 * (developer.flutterwave.com transfers reference).
 */

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function fetchQueue(handlers: Array<(call: FetchCall) => { status?: number; body: unknown }>) {
  const calls: FetchCall[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const call: FetchCall = { url, ...(init !== undefined ? { init } : {}) };
    calls.push(call);
    const handler = handlers.shift();
    if (!handler) throw new Error(`unexpected fetch to ${url}`);
    const { status, body } = handler(call);
    return new Response(JSON.stringify(body), { status: status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

const config: FlutterwaveConfig = {
  secretKey: "FLWSECK_TEST-mock-X",
  webhookSecretHash: "test-secret-hash",
  baseUrl: "https://api.flutterwave.com",
  callbackUrl: null,
  testMode: false,
};

const request: DispatchTransferRequest = {
  idempotencyKey: "settlement:run:cart:Balogun:buyer:1:settlement:leg:0",
  recipient: { partyId: "seller:amina", account: "seller" },
  amountKobo: 165_000,
  memo: "Seller settlement",
};

function transferData(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: 26251,
    account_number: "0690000031",
    bank_code: "044",
    currency: "NGN",
    amount: 1650,
    fee: 45,
    status,
    reference: request.idempotencyKey,
    complete_message: "",
    ...extra,
  };
}

describe("flutterwaveConfig", () => {
  it("throws loudly with the exact guidance message when FLUTTERWAVE_SECRET_KEY is missing", () => {
    const message =
      "PAYMENT_DISPATCHER=flutterwave requires FLUTTERWAVE_SECRET_KEY — " +
      "drop a FLWSECK_TEST-… key into infra/.dev.vars (see infra/.dev.vars.example) or `wrangler secret put` it";
    expect(() => flutterwaveConfig({})).toThrow(message);
    expect(() => flutterwaveConfig({ FLUTTERWAVE_SECRET_KEY: "   " })).toThrow(message);
  });
});

describe("FlutterwaveDispatcher request mapping", () => {
  it("posts the v3 transfer body: kobo→naira, reference=idempotencyKey, Bearer auth", async () => {
    const { calls, fetchImpl } = fetchQueue([
      () => ({ body: { status: "success", message: "Transfer Queued Successfully", data: transferData("NEW") } }),
    ]);
    const dispatcher = new FlutterwaveDispatcher(config, new DevRecipientResolver(), fetchImpl);
    const result = await dispatcher.dispatchTransfer(request);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.flutterwave.com/v3/transfers");
    expect(call.init?.method).toBe("POST");
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer FLWSECK_TEST-mock-X");
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      account_bank: "044", // the dev fallback: Flutterwave's documented test account
      account_number: "0690000031",
      amount: 1650, // 165_000 kobo → ₦1,650 at the vendor boundary
      currency: "NGN",
      debit_currency: "NGN",
      narration: "Seller settlement",
      reference: request.idempotencyKey,
      beneficiary_name: "TEST — Forrest Green",
    });
    expect(result.status).toBe("queued");
    expect(result.providerRef).toBe(`${PROVIDER_REF_PREFIX}26251`);
  });

  it("sends callback_url only when configured", async () => {
    const { calls, fetchImpl } = fetchQueue([
      () => ({ body: { status: "success", data: transferData("NEW") } }),
    ]);
    const withCallback = new FlutterwaveDispatcher(
      { ...config, callbackUrl: "https://ops.example.com/webhooks/transfers" },
      new DevRecipientResolver(),
      fetchImpl,
    );
    await withCallback.dispatchTransfer(request);
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.callback_url).toBe("https://ops.example.com/webhooks/transfers");
  });
});

describe("FlutterwaveDispatcher status mapping", () => {
  it.each([
    ["NEW", "queued"],
    ["PENDING", "sent"],
    ["SUCCESSFUL", "completed"],
  ] as const)("provider %s → %s", async (providerStatus, ours) => {
    const { fetchImpl } = fetchQueue([() => ({ body: { status: "success", data: transferData(providerStatus) } })]);
    const dispatcher = new FlutterwaveDispatcher(config, new DevRecipientResolver(), fetchImpl);
    const result = await dispatcher.dispatchTransfer(request);
    expect(result.status).toBe(ours);
    expect(result.providerRef).toBe(`${PROVIDER_REF_PREFIX}26251`);
  });

  it("provider FAILED → failed with complete_message as the reason", async () => {
    const { fetchImpl } = fetchQueue([
      () => ({ body: { status: "success", data: transferData("FAILED", { complete_message: "Account resolve failed" }) } }),
    ]);
    const dispatcher = new FlutterwaveDispatcher(config, new DevRecipientResolver(), fetchImpl);
    const result = await dispatcher.dispatchTransfer(request);
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("Account resolve failed");
    expect(result.retryable).toBe(false);
  });

  it("error envelope → failed with the provider message", async () => {
    const { fetchImpl } = fetchQueue([
      () => ({ status: 400, body: { status: "error", message: "No account number or recipient identifier passed", data: null } }),
    ]);
    const dispatcher = new FlutterwaveDispatcher(config, new DevRecipientResolver(), fetchImpl);
    const result = await dispatcher.dispatchTransfer(request);
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("No account number or recipient identifier passed");
    expect(result.providerRef).toBeUndefined();
    expect(result.retryable).toBe(false);
  });

  it("duplicate reference collapses onto the ORIGINAL transfer looked up by reference", async () => {
    const { calls, fetchImpl } = fetchQueue([
      () => ({ status: 400, body: { status: "error", message: "Payout with this ref already exists", data: null } }),
      (call) => {
        expect(call.url).toBe(
          `https://api.flutterwave.com/v3/transfers?reference=${encodeURIComponent(request.idempotencyKey)}`,
        );
        return { body: { status: "success", message: "Transfers fetched", data: [transferData("SUCCESSFUL", { id: 99999 })] } };
      },
    ]);
    const dispatcher = new FlutterwaveDispatcher(config, new DevRecipientResolver(), fetchImpl);
    const result = await dispatcher.dispatchTransfer(request);
    expect(calls).toHaveLength(2);
    expect(result.status).toBe("completed");
    expect(result.providerRef).toBe(`${PROVIDER_REF_PREFIX}99999`);
  });

  it("duplicate reference that cannot be resolved fails honestly", async () => {
    const { fetchImpl } = fetchQueue([
      () => ({ status: 400, body: { status: "error", message: "Payout with this ref already exists", data: null } }),
      () => ({ body: { status: "success", data: [] } }),
    ]);
    const dispatcher = new FlutterwaveDispatcher(config, new DevRecipientResolver(), fetchImpl);
    const result = await dispatcher.dispatchTransfer(request);
    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/duplicate-reference-unresolved/);
    expect(result.retryable).toBe(true);
  });

  it("network failure → failed (retryable; the duplicate path collapses the retry)", async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error("socket hangup");
    };
    const dispatcher = new FlutterwaveDispatcher(config, new DevRecipientResolver(), fetchImpl);
    const result = await dispatcher.dispatchTransfer(request);
    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/provider-unreachable/);
    expect(result.retryable).toBe(true);
  });
});

describe("FlutterwaveDispatcher guards (no HTTP call made)", () => {
  it("unresolved recipient → failed recipient-unresolved, replayable", async () => {
    const { calls, fetchImpl } = fetchQueue([]);
    const dispatcher = new FlutterwaveDispatcher(config, new DevRecipientResolver(), fetchImpl);
    const result = await dispatcher.dispatchTransfer({
      ...request,
      recipient: { partyId: "seller:unknown", account: "seller" },
    });
    expect(result).toEqual({ status: "failed", failureReason: "recipient-unresolved", retryable: false });
    expect(calls).toHaveLength(0);
  });

  it("below the ₦100 provider minimum → failed without calling the provider", async () => {
    const { calls, fetchImpl } = fetchQueue([]);
    const dispatcher = new FlutterwaveDispatcher(config, new DevRecipientResolver(), fetchImpl);
    const result = await dispatcher.dispatchTransfer({ ...request, amountKobo: 5_000 }); // ₦50
    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/below-provider-minimum/);
    expect(result.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("above the ₦1,000,000 per-transfer cap → failed without calling the provider", async () => {
    const { calls, fetchImpl } = fetchQueue([]);
    const dispatcher = new FlutterwaveDispatcher(config, new DevRecipientResolver(), fetchImpl);
    const result = await dispatcher.dispatchTransfer({ ...request, amountKobo: 100_000_001 });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/above-provider-maximum/);
    expect(result.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("FlutterwaveDispatcher.fetchTransferStatus (sync)", () => {
  it("polls GET /v3/transfers/:id from the providerRef and maps the state", async () => {
    const { calls, fetchImpl } = fetchQueue([
      () => ({ body: { status: "success", data: transferData("SUCCESSFUL", { complete_message: "Transaction was successful" }) } }),
    ]);
    const dispatcher = new FlutterwaveDispatcher(config, new DevRecipientResolver(), fetchImpl);
    const result = await dispatcher.fetchTransferStatus(`${PROVIDER_REF_PREFIX}26251`);
    expect(calls[0]?.url).toBe("https://api.flutterwave.com/v3/transfers/26251");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer FLWSECK_TEST-mock-X");
    expect(result?.status).toBe("completed");
  });

  it("returns null for foreign providerRefs and provider errors", async () => {
    const { fetchImpl } = fetchQueue([() => ({ status: 400, body: { status: "error", message: "Transfer not found", data: null } })]);
    const dispatcher = new FlutterwaveDispatcher(config, new DevRecipientResolver(), fetchImpl);
    expect(await dispatcher.fetchTransferStatus("stub:abcdef")).toBeNull();
    expect(await dispatcher.fetchTransferStatus(`${PROVIDER_REF_PREFIX}nope`)).toBeNull();
  });
});

describe("mapProviderTransfer", () => {
  it("is case-insensitive and treats unknown states as still-in-flight (queued)", () => {
    expect(mapProviderTransfer({ id: 1, status: "successful" }).status).toBe("completed");
    expect(mapProviderTransfer({ id: 1, status: "processing" }).status).toBe("queued");
    expect(mapProviderTransfer({ id: 1 }).status).toBe("queued");
  });
});

describe("DevRecipientResolver", () => {
  it("falls back to Flutterwave's documented TEST accounts for the demo parties", async () => {
    const resolver = new DevRecipientResolver();
    expect(await resolver.resolve("Amina's Fresh Store", "seller")).toEqual({
      accountBank: "044",
      accountNumber: "0690000031",
      accountName: "TEST — Forrest Green",
    });
    expect((await resolver.resolve("Mama Ngozi Provisions", "seller"))?.accountNumber).toBe("0690000032");
    expect((await resolver.resolve("Emeka Phones & Accessories", "seller"))?.accountNumber).toBe("0690000033");
    // Pre-ADR-0018 fixtures still resolve.
    expect((await resolver.resolve("seller:amina", "seller"))?.accountNumber).toBe("0690000031");
    expect((await resolver.resolve("runner:internal", "runner"))?.accountNumber).toBe("0690000032");
    expect((await resolver.resolve("platform", "platform"))?.accountNumber).toBe("0690000033");
  });

  it("omits the published test accounts when the key is live, unless the env map names the party", async () => {
    const live = new DevRecipientResolver(undefined, { includeTestDefaults: false });
    expect(await live.resolve("Amina's Fresh Store", "seller")).toBeNull();
    expect(await live.resolve("runner:internal", "runner")).toBeNull();

    const explicit = new DevRecipientResolver(
      JSON.stringify({ "Amina's Fresh Store": { bank: "058", account: "0123456789" } }),
      { includeTestDefaults: false },
    );
    expect((await explicit.resolve("Amina's Fresh Store", "seller"))?.accountNumber).toBe("0123456789");
    expect(await explicit.resolve("platform", "platform")).toBeNull();
  });

  it("env entries override the defaults per partyId", async () => {
    const resolver = new DevRecipientResolver(
      JSON.stringify({ "seller:amina": { bank: "058", account: "0123456789", name: "Amina Bello" } }),
    );
    expect(await resolver.resolve("seller:amina", "seller")).toEqual({
      accountBank: "058",
      accountNumber: "0123456789",
      accountName: "Amina Bello",
    });
    // Untouched keys keep the test-account fallback.
    expect((await resolver.resolve("runner:internal", "runner"))?.accountNumber).toBe("0690000032");
  });

  it("unknown partyId resolves to null (dispatch fails recipient-unresolved)", async () => {
    const resolver = new DevRecipientResolver("{}");
    expect(await resolver.resolve("seller:bola", "seller")).toBeNull();
  });

  it("malformed env JSON and malformed entries throw loudly at construction", () => {
    expect(() => new DevRecipientResolver("{not json")).toThrow(/not valid JSON/);
    expect(() => new DevRecipientResolver('{"seller:x":{"account":"1"}}')).toThrow(/bank must be/);
    expect(() => new DevRecipientResolver('[1,2]')).toThrow(/keyed by partyId/);
  });
});

describe("webhook verification and parsing", () => {
  it("verifyWebhookHash accepts the configured secret hash and rejects anything else", async () => {
    expect(await verifyWebhookHash("s3cret", "s3cret")).toBe(true);
    expect(await verifyWebhookHash("s3cret", "s3cretx")).toBe(false);
    expect(await verifyWebhookHash("s3cret", null)).toBe(false);
    expect(await verifyWebhookHash("s3cret", "")).toBe(false);
  });

  it("parses a v3 transfer.completed SUCCESSFUL payload", () => {
    const parsed = parseTransferWebhook({
      event: "transfer.completed",
      "event.type": "Transfer",
      data: { id: 708320, reference: "settlement:x:leg:0", status: "SUCCESSFUL", complete_message: "Transaction was successful" },
    });
    expect(parsed).toEqual({
      kind: "outcome",
      outcome: { reference: "settlement:x:leg:0", providerRef: "flw:708320", status: "completed", completeMessage: "Transaction was successful" },
    });
  });

  it("parses a v4 transfer.disburse FAILED payload", () => {
    const parsed = parseTransferWebhook({
      webhook_id: "wbk_1",
      type: "transfer.disburse",
      data: { id: "trf_yMZATJ11yVPNkZ", reference: "settlement:x:leg:1", status: "FAILED" },
    });
    expect(parsed).toEqual({
      kind: "outcome",
      outcome: { reference: "settlement:x:leg:1", providerRef: "flw:trf_yMZATJ11yVPNkZ", status: "failed", completeMessage: null },
    });
  });

  it("ignores non-transfer events and non-terminal transfer states", () => {
    expect(parseTransferWebhook({ event: "charge.completed", data: { id: 1 } }).kind).toBe("ignored");
    expect(
      parseTransferWebhook({ event: "transfer.completed", data: { id: 1, reference: "r", status: "PENDING" } }).kind,
    ).toBe("ignored");
  });

  it("rejects malformed transfer payloads", () => {
    expect(parseTransferWebhook("junk").kind).toBe("invalid");
    expect(parseTransferWebhook({ event: "transfer.completed" }).kind).toBe("invalid");
    expect(parseTransferWebhook({ event: "transfer.completed", data: { status: "SUCCESSFUL" } }).kind).toBe("invalid");
  });
});

describe("test-mode transfer accelerator (FLUTTERWAVE_TEST_MODE)", () => {
  const testConfig: FlutterwaveConfig = { ...config, testMode: true };

  it("sends the reference with the mock success suffix in test mode", async () => {
    const { calls, fetchImpl } = fetchQueue([
      () => ({
        body: {
          status: "success",
          data: transferData("PENDING", { reference: `${request.idempotencyKey}${TEST_MODE_SUCCESS_SUFFIX}` }),
        },
      }),
    ]);
    const dispatcher = new FlutterwaveDispatcher(testConfig, new DevRecipientResolver(), fetchImpl);
    const result = await dispatcher.dispatchTransfer(request);

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.reference).toBe(`${request.idempotencyKey}${TEST_MODE_SUCCESS_SUFFIX}`);
    expect(result.status).toBe("sent");
  });

  it("sends the bare idempotency key outside test mode", async () => {
    const { calls, fetchImpl } = fetchQueue([
      () => ({ body: { status: "success", data: transferData("NEW") } }),
    ]);
    const dispatcher = new FlutterwaveDispatcher(config, new DevRecipientResolver(), fetchImpl);
    await dispatcher.dispatchTransfer(request);
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.reference).toBe(request.idempotencyKey);
  });

  it("duplicate-collapse lookups use the suffixed reference in test mode", async () => {
    const { calls, fetchImpl } = fetchQueue([
      () => ({ status: 400, body: { status: "error", message: "Payout with this ref already exists", data: null } }),
      () => ({ body: { status: "success", data: [transferData("SUCCESSFUL", { id: 42424 })] } }),
    ]);
    const dispatcher = new FlutterwaveDispatcher(testConfig, new DevRecipientResolver(), fetchImpl);
    const result = await dispatcher.dispatchTransfer(request);
    expect(calls[1]?.url).toBe(
      `https://api.flutterwave.com/v3/transfers?reference=${encodeURIComponent(`${request.idempotencyKey}${TEST_MODE_SUCCESS_SUFFIX}`)}`,
    );
    expect(result.status).toBe("completed");
  });

  it("webhook parse strips the suffix back to the idempotency key in test mode only", () => {
    const body = {
      event: "transfer.completed",
      data: {
        id: 708320,
        reference: `${request.idempotencyKey}${TEST_MODE_SUCCESS_SUFFIX}`,
        status: "SUCCESSFUL",
        complete_message: "Transaction was successful",
      },
    };

    const testIntegration = createVendorIntegration({
      FLUTTERWAVE_SECRET_KEY: "FLWSECK_TEST-mock-X",
      FLUTTERWAVE_TEST_MODE: "1",
    });
    const testParsed = testIntegration.webhook?.hooks.parse(body);
    expect(testParsed?.kind).toBe("outcome");
    if (testParsed?.kind === "outcome") {
      expect(testParsed.outcome.reference).toBe(request.idempotencyKey);
    }

    const liveIntegration = createVendorIntegration({ FLUTTERWAVE_SECRET_KEY: "FLWSECK-mock-X" });
    const liveParsed = liveIntegration.webhook?.hooks.parse(body);
    if (liveParsed?.kind === "outcome") {
      // Outside test mode a reference is matched verbatim — no stripping.
      expect(liveParsed.outcome.reference).toBe(`${request.idempotencyKey}${TEST_MODE_SUCCESS_SUFFIX}`);
    }
  });

  it("reference helpers round-trip only under test mode", () => {
    expect(outboundReference("k", true)).toBe(`k${TEST_MODE_SUCCESS_SUFFIX}`);
    expect(outboundReference("k", false)).toBe("k");
    expect(inboundReference(`k${TEST_MODE_SUCCESS_SUFFIX}`, true)).toBe("k");
    expect(inboundReference(`k${TEST_MODE_SUCCESS_SUFFIX}`, false)).toBe(`k${TEST_MODE_SUCCESS_SUFFIX}`);
    expect(inboundReference("k", true)).toBe("k");
    expect(TEST_MODE_FAILURE_SUFFIX).toBe("_PMCK_ST_FDU_1");
  });

  it("flutterwaveConfig treats only truthy FLUTTERWAVE_TEST_MODE values as on", () => {
    const base = { FLUTTERWAVE_SECRET_KEY: "FLWSECK_TEST-mock-X" };
    expect(flutterwaveConfig(base).testMode).toBe(false);
    expect(flutterwaveConfig({ ...base, FLUTTERWAVE_TEST_MODE: "" }).testMode).toBe(false);
    expect(flutterwaveConfig({ ...base, FLUTTERWAVE_TEST_MODE: "0" }).testMode).toBe(false);
    expect(flutterwaveConfig({ ...base, FLUTTERWAVE_TEST_MODE: "false" }).testMode).toBe(false);
    expect(flutterwaveConfig({ ...base, FLUTTERWAVE_TEST_MODE: "1" }).testMode).toBe(true);
    expect(flutterwaveConfig({ ...base, FLUTTERWAVE_TEST_MODE: "true" }).testMode).toBe(true);
  });
});
