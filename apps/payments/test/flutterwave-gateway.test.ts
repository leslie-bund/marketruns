import { describe, expect, it } from "vitest";
import { FlutterwaveGateway, REFUND_PROVIDER_REF_PREFIX, parseChargeWebhook } from "../src/flutterwave/index.js";
import type { FlutterwaveConfig } from "../src/flutterwave/index.js";

/**
 * The vendor gateway against a mocked fetch: verify maps provider truth
 * (naira → kobo at the boundary), refunds send partial amounts in naira and
 * omit amount for full refunds, the bank directory and account resolve hit
 * the documented v3 endpoints. No live API calls.
 */

const CONFIG: FlutterwaveConfig = {
  secretKey: "FLWSECK_TEST-fake",
  webhookSecretHash: null,
  baseUrl: "https://api.flutterwave.com",
  callbackUrl: null,
  testMode: false,
};

type FetchCall = { url: string; init?: RequestInit };

function fetchMock(routes: Array<{ match: string; body: unknown; status?: number }>) {
  const calls: FetchCall[] = [];
  const impl = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, ...(init !== undefined ? { init } : {}) });
    const route = routes.find((candidate) => input.startsWith(candidate.match));
    if (!route) return new Response(JSON.stringify({ status: "error", message: "no route", data: null }), { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  };
  return { calls, impl };
}

describe("FlutterwaveGateway.verifyCharge", () => {
  it("verifies by transaction id and converts naira to kobo", async () => {
    const mock = fetchMock([
      {
        match: "https://api.flutterwave.com/v3/transactions/9049104/verify",
        body: {
          status: "success",
          data: { id: 9049104, tx_ref: "mr-abc", status: "successful", amount: 3350, currency: "NGN", payment_type: "card" },
        },
      },
    ]);
    const gateway = new FlutterwaveGateway(CONFIG, mock.impl);
    const verified = await gateway.verifyCharge({ transactionId: "9049104" });
    expect(verified).toEqual({
      txRef: "mr-abc",
      providerTxId: "9049104",
      amountKobo: 335_000,
      currency: "NGN",
      paymentMethod: "card",
      status: "successful",
    });
    expect((mock.calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer FLWSECK_TEST-fake");
  });

  it("verifies by tx_ref via verify_by_reference; unknown charges return null", async () => {
    const mock = fetchMock([
      {
        match: "https://api.flutterwave.com/v3/transactions/verify_by_reference",
        body: {
          status: "success",
          data: { id: 7, tx_ref: "mr-xyz", status: "successful", amount: 100.5, currency: "NGN", payment_type: "ussd" },
        },
      },
    ]);
    const gateway = new FlutterwaveGateway(CONFIG, mock.impl);
    const verified = await gateway.verifyCharge({ txRef: "mr-xyz" });
    expect(mock.calls[0]?.url).toContain("verify_by_reference?tx_ref=mr-xyz");
    expect(verified?.amountKobo).toBe(10_050); // decimal naira → kobo, rounded
    expect(verified?.paymentMethod).toBe("ussd");

    const missing = await new FlutterwaveGateway(
      CONFIG,
      fetchMock([
        { match: "https://api.flutterwave.com/v3/transactions/verify_by_reference", body: { status: "error", message: "No transaction found", data: null } },
      ]).impl,
    ).verifyCharge({ txRef: "nope" });
    expect(missing).toBeNull();
  });
});

describe("FlutterwaveGateway.refundCharge", () => {
  it("sends a partial refund amount in NAIRA (kobo converts at the boundary)", async () => {
    const mock = fetchMock([
      { match: "https://api.flutterwave.com/v3/transactions/9049104/refund", body: { status: "success", data: { id: 555 } } },
    ]);
    const gateway = new FlutterwaveGateway(CONFIG, mock.impl);
    const result = await gateway.refundCharge("9049104", 100_000, "Buyer refund x");
    expect(result).toEqual({ status: "processing", providerRef: `${REFUND_PROVIDER_REF_PREFIX}555` });
    const body = JSON.parse(String(mock.calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ amount: 1000, comments: "Buyer refund x" });
  });

  it("omits amount for a full refund (provider semantics), and fails honestly on provider errors", async () => {
    const mock = fetchMock([
      { match: "https://api.flutterwave.com/v3/transactions/1/refund", body: { status: "success", data: { id: 9 } } },
      { match: "https://api.flutterwave.com/v3/transactions/2/refund", body: { status: "error", message: "Transaction already fully refunded" } },
    ]);
    const gateway = new FlutterwaveGateway(CONFIG, mock.impl);

    const full = await gateway.refundCharge("1", null, "full");
    expect(full.status).toBe("processing");
    const body = JSON.parse(String(mock.calls[0]?.init?.body)) as Record<string, unknown>;
    expect("amount" in body).toBe(false);

    const failed = await gateway.refundCharge("2", null, "again");
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toContain("already fully refunded");
  });

  it("supportsRefund is card-only (non-card has no API rail)", () => {
    const gateway = new FlutterwaveGateway(CONFIG, fetchMock([]).impl);
    expect(gateway.supportsRefund("card")).toBe(true);
    expect(gateway.supportsRefund("bank_transfer")).toBe(false);
    expect(gateway.supportsRefund("ussd")).toBe(false);
  });
});

describe("FlutterwaveGateway.listBanks / resolveAccount", () => {
  it("maps the NG bank directory to code+name", async () => {
    const mock = fetchMock([
      { match: "https://api.flutterwave.com/v3/banks/NG", body: { status: "success", data: [{ id: 191, code: "044", name: "Access Bank" }] } },
    ]);
    const gateway = new FlutterwaveGateway(CONFIG, mock.impl);
    expect(await gateway.listBanks()).toEqual([{ code: "044", name: "Access Bank" }]);
  });

  it("resolves account names; unresolvable accounts return null", async () => {
    const mock = fetchMock([
      {
        match: "https://api.flutterwave.com/v3/accounts/resolve",
        body: { status: "success", data: { account_number: "0690000032", account_name: "Pastor Bright" } },
      },
    ]);
    const gateway = new FlutterwaveGateway(CONFIG, mock.impl);
    const resolved = await gateway.resolveAccount("044", "0690000032");
    expect(resolved).toEqual({ accountName: "Pastor Bright" });
    const body = JSON.parse(String(mock.calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ account_bank: "044", account_number: "0690000032" });
  });
});

describe("parseChargeWebhook", () => {
  it("classifies charge.completed with meta; ignores everything else", () => {
    const parsed = parseChargeWebhook({
      event: "charge.completed",
      data: { id: 9049104, tx_ref: "mr-abc", status: "successful", meta: { cartId: "cart:1", buyerId: "buyer:1" } },
    });
    expect(parsed).toEqual({
      kind: "charge",
      charge: { txRef: "mr-abc", transactionId: "9049104", cartId: "cart:1", buyerId: "buyer:1" },
    });

    expect(parseChargeWebhook({ event: "transfer.completed", data: {} }).kind).toBe("ignored");
    expect(parseChargeWebhook({ event: "charge.completed", data: {} }).kind).toBe("invalid");
    expect(parseChargeWebhook("junk").kind).toBe("invalid");
  });
});
