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
  });
}

function post(path: string, body: unknown) {
  return new Request(`http://payments${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

    const found = await worker.fetch(new Request("http://payments/payments/payout-accounts/seller:amina"));
    expect(found.status).toBe(200);
    expect(((await found.json()) as { accountName: string }).accountName).toBe("Amina Yusuf");

    const revoked = await worker.fetch(
      new Request("http://payments/payments/payout-accounts/seller:amina", { method: "DELETE" }),
    );
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as { revokedAt: number | null }).revokedAt).not.toBeNull();

    expect((await worker.fetch(new Request("http://payments/payments/payout-accounts/seller:amina"))).status).toBe(404);
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
