import { describe, expect, it } from "vitest";
import type { ChargeGateway, ChargeRefundResult, ChargeVerification } from "../src/gateway.js";
import type { PaymentBankView } from "@market-runs/proto";
import { createPaymentsApp } from "../src/index.js";
import { StubDispatcher } from "../src/dispatcher.js";
import { ChainRecipientResolver, RECIPIENT_UNRESOLVED } from "../src/recipients.js";
import { DbRecipientResolver } from "../src/payout-accounts.js";
import { DevRecipientResolver } from "../src/flutterwave/index.js";
import { InMemoryDispatchStore, InMemoryPayoutAccountStore } from "./helpers.js";

/**
 * Payout accounts: bank directory (TTL-cached), provider-resolved account
 * saves (never stored unresolved), and DB-first recipient resolution with the
 * dev fallbacks behind it.
 */

class AccountGateway implements ChargeGateway {
  bankFetches = 0;
  resolveCalls: Array<{ bankCode: string; accountNumber: string }> = [];
  constructor(private readonly accountName: string | null) {}
  async verifyCharge(): Promise<ChargeVerification | null> {
    throw new Error("not used");
  }
  async refundCharge(): Promise<ChargeRefundResult> {
    throw new Error("not used");
  }
  async reconcileRefund() {
    return { status: "not-found" as const };
  }
  supportsRefund(): boolean {
    return false;
  }
  async listBanks(): Promise<PaymentBankView[]> {
    this.bankFetches += 1;
    return [
      { code: "044", name: "Access Bank" },
      { code: "058", name: "GTBank Plc" },
    ];
  }
  async resolveAccount(bankCode: string, accountNumber: string) {
    this.resolveCalls.push({ bankCode, accountNumber });
    return this.accountName === null ? null : { accountName: this.accountName };
  }
}

function appWith(accounts: InMemoryPayoutAccountStore, gateway: ChargeGateway | null) {
  return createPaymentsApp(new InMemoryDispatchStore(), new StubDispatcher(), {
    payouts: { accounts, gateway },
    participantAuth: { allowHeaderAuth: true },
  });
}

function demoHeaders(participantId: string) {
  return { "x-participant-id": participantId, "x-participant-role": "seller" };
}

function post(path: string, body: unknown) {
  const participantId = typeof body === "object" && body !== null && "participantId" in body
    ? String(body.participantId)
    : "seller:demo";
  return new Request(`http://payments${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...demoHeaders(participantId) },
    body: JSON.stringify(body),
  });
}

describe("GET /payments/banks", () => {
  it("lists the bank directory and caches it (one provider fetch across calls)", async () => {
    const gateway = new AccountGateway(null);
    const worker = appWith(new InMemoryPayoutAccountStore(), gateway);

    const first = await worker.fetch(new Request("http://payments/payments/banks"));
    expect(first.status).toBe(200);
    const body = (await first.json()) as { items: PaymentBankView[]; cachedAt: number };
    expect(body.items.map((bank) => bank.code)).toEqual(["044", "058"]);

    const second = await worker.fetch(new Request("http://payments/payments/banks"));
    expect(second.status).toBe(200);
    expect(gateway.bankFetches).toBe(1); // TTL cache, not a second provider call
  });

  it("503s without a provider", async () => {
    const response = await appWith(new InMemoryPayoutAccountStore(), null).fetch(
      new Request("http://payments/payments/banks"),
    );
    expect(response.status).toBe(503);
  });
});

describe("payout-account resolve → save → read → revoke", () => {
  it("resolve returns the account name without storing anything", async () => {
    const accounts = new InMemoryPayoutAccountStore();
    const gateway = new AccountGateway("Amina Yusuf");
    const worker = appWith(accounts, gateway);

    const resolved = await worker.fetch(
      post("/payments/payout-accounts/resolve", { bankCode: "044", accountNumber: "0690000031" }),
    );
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toEqual({ bankCode: "044", accountNumber: "0690000031", accountName: "Amina Yusuf" });
    expect(accounts.rows.size).toBe(0);
  });

  it("save stores ONLY after provider resolution; 422s and stores nothing when unresolvable", async () => {
    const accounts = new InMemoryPayoutAccountStore();
    const worker = appWith(accounts, new AccountGateway("Amina Yusuf"));

    const saved = await worker.fetch(
      post("/payments/payout-accounts", { participantId: "seller:amina", bankCode: "044", accountNumber: "0690000031" }),
    );
    expect(saved.status).toBe(200);
    const view = (await saved.json()) as { participantId: string; accountName: string; verifiedAt: number; revokedAt: null };
    expect(view.accountName).toBe("Amina Yusuf");
    expect(view.revokedAt).toBeNull();

    const unresolvable = appWith(accounts, new AccountGateway(null));
    const refused = await unresolvable.fetch(
      post("/payments/payout-accounts", { participantId: "seller:bad", bankCode: "044", accountNumber: "0000000000" }),
    );
    expect(refused.status).toBe(422);
    expect(accounts.rows.has("seller:bad")).toBe(false);
  });

  it("GET returns the active account; DELETE revokes it (revoked = not found)", async () => {
    const accounts = new InMemoryPayoutAccountStore();
    const worker = appWith(accounts, new AccountGateway("Amina Yusuf"));
    await worker.fetch(
      post("/payments/payout-accounts", { participantId: "seller:amina", bankCode: "044", accountNumber: "0690000031" }),
    );

    const found = await worker.fetch(
      new Request("http://payments/payments/payout-accounts/seller:amina", { headers: demoHeaders("seller:amina") }),
    );
    expect(found.status).toBe(200);
    expect(((await found.json()) as { accountName: string }).accountName).toBe("Amina Yusuf");

    const revoked = await worker.fetch(
      new Request("http://payments/payments/payout-accounts/seller:amina", {
        method: "DELETE",
        headers: demoHeaders("seller:amina"),
      }),
    );
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as { revokedAt: number | null }).revokedAt).not.toBeNull();

    expect((await worker.fetch(
      new Request("http://payments/payments/payout-accounts/seller:amina", { headers: demoHeaders("seller:amina") }),
    )).status).toBe(404);
  });
});

const INTERNAL_TOKEN = "payments-internal-test-token";

function secureAppWith(
  accounts: InMemoryPayoutAccountStore,
  gateway: ChargeGateway | null = new AccountGateway("Amina Yusuf"),
  participantAuth: { internalToken?: string; allowHeaderAuth?: boolean } = { internalToken: INTERNAL_TOKEN },
) {
  return createPaymentsApp(new InMemoryDispatchStore(), new StubDispatcher(), {
    payouts: { accounts, gateway },
    participantAuth,
  });
}

function internalHeaders(participantId: string, role = "seller", token: string | null = INTERNAL_TOKEN) {
  return {
    ...(token === null ? {} : { "x-payments-internal": token }),
    "x-participant-id": participantId,
    "x-participant-role": role,
  };
}

function authedPost(path: string, body: unknown, headers: Record<string, string>) {
  return new Request(`http://payments${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function seedAccount(accounts: InMemoryPayoutAccountStore, participantId = "seller:amina") {
  await accounts.upsert({
    participantId,
    bankCode: "044",
    accountNumber: "0690000031",
    accountName: "Amina Yusuf",
    verifiedAt: new Date(),
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("payout-account participant authorization", () => {
  it("denies cross-participant reads, replacement, and revocation", async () => {
    const accounts = new InMemoryPayoutAccountStore();
    await seedAccount(accounts);
    const worker = secureAppWith(accounts);
    const attacker = internalHeaders("seller:attacker");

    const read = await worker.fetch(
      new Request("http://payments/payments/payout-accounts/seller:amina", { headers: attacker }),
    );
    expect(read.status).toBe(403);

    const replaced = await worker.fetch(
      authedPost(
        "/payments/payout-accounts",
        { participantId: "seller:amina", bankCode: "058", accountNumber: "2222222222" },
        attacker,
      ),
    );
    expect(replaced.status).toBe(403);
    expect(accounts.rows.get("seller:amina")?.accountNumber).toBe("0690000031");

    const revoked = await worker.fetch(
      new Request("http://payments/payments/payout-accounts/seller:amina", { method: "DELETE", headers: attacker }),
    );
    expect(revoked.status).toBe(403);
    expect(accounts.rows.get("seller:amina")?.revokedAt).toBeNull();
  });

  it("requires a valid internal token even when participant headers are supplied", async () => {
    const accounts = new InMemoryPayoutAccountStore();
    await seedAccount(accounts);
    const worker = secureAppWith(accounts);

    const missing = await worker.fetch(
      new Request("http://payments/payments/payout-accounts/seller:amina", {
        headers: internalHeaders("seller:amina", "seller", null),
      }),
    );
    expect(missing.status).toBe(401);

    const forged = await worker.fetch(
      new Request("http://payments/payments/payout-accounts/seller:amina", {
        headers: internalHeaders("seller:amina", "seller", "client-forged-token"),
      }),
    );
    expect(forged.status).toBe(401);
  });

  it("allows the legitimate seller and masks the saved account number", async () => {
    const accounts = new InMemoryPayoutAccountStore();
    await seedAccount(accounts);
    const response = await secureAppWith(accounts).fetch(
      new Request("http://payments/payments/payout-accounts/seller:amina", {
        headers: internalHeaders("seller:amina"),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { participantId: string; accountNumber: string };
    expect(body.participantId).toBe("seller:amina");
    expect(body.accountNumber).toBe("******0031");
    expect(body.accountNumber).not.toContain("0690000031");
  });

  it("allows a runner to manage only their own payout account", async () => {
    const accounts = new InMemoryPayoutAccountStore();
    const worker = secureAppWith(accounts);
    const saved = await worker.fetch(
      authedPost(
        "/payments/payout-accounts",
        { participantId: "runner:1", bankCode: "044", accountNumber: "0690000031" },
        internalHeaders("runner:1", "runner"),
      ),
    );
    expect(saved.status).toBe(200);
    expect(accounts.rows.has("runner:1")).toBe(true);
  });

  it("rejects buyers and fails closed when no internal token is configured", async () => {
    const accounts = new InMemoryPayoutAccountStore();
    await seedAccount(accounts);

    const buyer = await secureAppWith(accounts).fetch(
      new Request("http://payments/payments/payout-accounts/seller:amina", {
        headers: internalHeaders("seller:amina", "buyer"),
      }),
    );
    expect(buyer.status).toBe(403);

    const unconfigured = await secureAppWith(accounts, new AccountGateway("Amina Yusuf"), {}).fetch(
      new Request("http://payments/payments/payout-accounts/seller:amina", {
        headers: internalHeaders("seller:amina"),
      }),
    );
    expect(unconfigured.status).toBe(503);
  });
});

describe("DbRecipientResolver (DB-first, dev fallback last)", () => {
  const devMap = JSON.stringify({ "runner:internal": { bank: "057", account: "1111111111", name: "Env Runner" } });

  it("resolves from payout_accounts first", async () => {
    const accounts = new InMemoryPayoutAccountStore();
    await accounts.upsert({
      participantId: "seller:amina",
      bankCode: "058",
      accountNumber: "2222222222",
      accountName: "Amina Yusuf",
      verifiedAt: new Date(),
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const resolver = new ChainRecipientResolver([new DbRecipientResolver(accounts), new DevRecipientResolver(devMap)]);
    const resolved = await resolver.resolve("seller:amina", "seller");
    expect(resolved).toEqual({ accountBank: "058", accountNumber: "2222222222", accountName: "Amina Yusuf" });
  });

  it("falls back to the env map, then the documented test accounts, then unresolved", async () => {
    const accounts = new InMemoryPayoutAccountStore();
    const resolver = new ChainRecipientResolver([new DbRecipientResolver(accounts), new DevRecipientResolver(devMap)]);

    // Not in the DB → env map entry wins.
    expect(await resolver.resolve("runner:internal", "runner")).toEqual({
      accountBank: "057",
      accountNumber: "1111111111",
      accountName: "Env Runner",
    });
    // In neither → the dev test-account default.
    expect((await resolver.resolve("platform", "platform"))?.accountNumber).toBe("0690000033");
    // Unknown everywhere → null (the dispatcher then fails recipient-unresolved).
    expect(await resolver.resolve("seller:ghost", "seller")).toBeNull();
  });

  it("a revoked DB account falls through to the dev fallback", async () => {
    const accounts = new InMemoryPayoutAccountStore();
    await accounts.upsert({
      participantId: "runner:internal",
      bankCode: "058",
      accountNumber: "2222222222",
      accountName: "Revoked Runner",
      verifiedAt: new Date(),
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await accounts.revoke("runner:internal");
    const resolver = new ChainRecipientResolver([new DbRecipientResolver(accounts), new DevRecipientResolver(devMap)]);
    expect((await resolver.resolve("runner:internal", "runner"))?.accountName).toBe("Env Runner");
  });

  it("RECIPIENT_UNRESOLVED stays the honest failure token", () => {
    expect(RECIPIENT_UNRESOLVED).toBe("recipient-unresolved");
  });
});
