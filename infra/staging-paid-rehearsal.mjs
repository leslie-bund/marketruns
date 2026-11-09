#!/usr/bin/env node
/**
 * Real paid/hybrid staging rehearsal. This is deliberately separate from
 * e2e-session.mjs: every participant call uses a real Bearer session, the
 * collection is a real Flutterwave TEST charge, and every assertion is strict.
 *
 * Usage (from repo root):
 *   node infra/staging-paid-rehearsal.mjs --fresh --phase=setup
 *   node infra/staging-paid-rehearsal.mjs --phase=trade
 *   node infra/staging-paid-rehearsal.mjs --phase=handoffs
 *   node infra/staging-paid-rehearsal.mjs --phase=settle
 *
 * Secrets and Bearer tokens live only in the ignored, mode-0600 state file.
 * The evidence file contains ids/statuses, never sessions, proofs, card data,
 * provider credentials, delivery codes, database URLs, or operator cookies.
 */

import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import sharp from "../apps/biometrics/node_modules/sharp/lib/index.js";
import { Agent, setGlobalDispatcher } from "../node_modules/.pnpm/undici@7.30.0/node_modules/undici/index.js";
import { loadDevVars } from "./dev-vars.mjs";

// Optional harness-only workaround for a local ISP/anycast route failure. TLS
// still verifies the real Worker hostname; this never changes staging config.
const workerIp = process.env.STAGING_WORKER_IP?.trim();
if (workerIp) {
  if (!/^188\.114\.(?:96|97|98|99)\.0$/.test(workerIp)) throw new Error("STAGING_WORKER_IP must be a Cloudflare Workers service address");
  setGlobalDispatcher(new Agent({
    connect: {
      lookup(hostname, options, callback) {
        if (hostname.endsWith(".workers.dev")) {
          return options?.all
            ? callback(null, [{ address: workerIp, family: 4 }])
            : callback(null, workerIp, 4);
        }
        return dns.lookup(hostname, options, callback);
      },
    },
  }));
}

const ROOT = process.cwd();
const WORK = path.join(ROOT, "tmp", "staging-paid-rehearsal");
const STATE_PATH = path.join(WORK, "state.json");
const EVIDENCE_PATH = path.join(WORK, "evidence.json");
const IMAGE_PATH = path.join(WORK, "aligned-crop.png");
const STAGING_VARS = fileURLToPath(new URL("./.staging/.dev.vars", import.meta.url));
const RECONCILE_PATH = fileURLToPath(new URL("./reconcile.mjs", import.meta.url));
const MARKET = "Balogun";
const REUSE_BUYER = process.env.STAGING_EXISTING_BUYER?.trim();
const DELIVERY = { kind: "plus-code", plusCode: "6FR5+8X Lagos" };
const STORE_ITEM = "Tomatoes";
const STORE_POINT = "Balogun Market, Stall B14";
const PHASES = new Set(["setup", "trade", "handoffs", "settle", "all"]);

fs.mkdirSync(WORK, { recursive: true, mode: 0o700 });
loadDevVars(STAGING_VARS);

const args = new Set(process.argv.slice(2));
const phase = [...args].find((arg) => arg.startsWith("--phase="))?.slice("--phase=".length) ?? "all";
if (!PHASES.has(phase)) throw new Error(`unknown phase ${phase}`);
if (args.has("--fresh") && fs.existsSync(STATE_PATH)) {
  fs.rmSync(STATE_PATH, { force: true });
  fs.rmSync(EVIDENCE_PATH, { force: true });
}
if (!args.has("--fresh") && !fs.existsSync(STATE_PATH) && phase !== "setup" && phase !== "all") {
  throw new Error("no rehearsal state; start with --fresh --phase=setup");
}
for (const key of ["EDGE_PUBLIC_URL", "PAYMENTS_PUBLIC_URL", "DATABASE_URL", "FLUTTERWAVE_SECRET_KEY", "RECONCILE_PROVIDER_SINCE"]) {
  if (!process.env[key]) throw new Error(`missing required staging variable ${key}`);
}
if (!process.env.FLUTTERWAVE_SECRET_KEY.startsWith("FLWSECK_TEST-")) throw new Error("paid rehearsal requires a Flutterwave TEST secret");
if (!fs.existsSync(IMAGE_PATH)) throw new Error("copy the inherited aligned sample to tmp/staging-paid-rehearsal/aligned-crop.png first");

const edge = process.env.EDGE_PUBLIC_URL.replace(/\/$/, "");
const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8"))
  : {
      version: 1,
      tag,
      createdAt: new Date().toISOString(),
      roles: {
        seller: { participantId: `paid-seller-${tag}`, email: `paid-seller-${tag}@example.com` },
        runner: { participantId: `paid-runner-${tag}`, email: `paid-runner-${tag}@example.com` },
        buyer: { participantId: REUSE_BUYER ?? `paid-buyer-${tag}`, email: `paid-buyer-${tag}@example.com` },
      },
      trade: {},
      run: {},
    };

function saveState() {
  const temporary = `${STATE_PATH}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, STATE_PATH);
  fs.chmodSync(STATE_PATH, 0o600);
  writeEvidence();
}

function redactText(value) {
  return String(value)
    .replace(/FLWSECK_(?:TEST|LIVE)-\S+/g, "[redacted-provider-key]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-database-url]");
}

const SENSITIVE_KEY = /^(?:session|token|authorization|cookie|password|secret|enrollmentproof|image|livenessimages|card|card_number|cvv|pin|otp|client|code|deliverycode|flwref|flw_ref)$/i;
function safe(value, depth = 0) {
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) return value.map((entry) => safe(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .map(([key, entry]) => [key, safe(entry, depth + 1)]));
  }
  return value;
}

function writeEvidence(failure) {
  const roles = Object.fromEntries(Object.entries(state.roles).map(([name, role]) => [name, {
    participantId: role.participantId,
    email: role.email,
    jobId: role.jobId ?? null,
    enrolled: role.enrolled === true,
    kycStatus: role.kycStatus ?? null,
    bearerSessionObtained: typeof role.session?.token === "string",
    sessionTokenId: role.session?.tokenId ?? null,
    marketJoined: role.marketJoined === true,
    payoutAccount: role.payoutAccount ?? null,
  }]));
  const evidence = {
    rehearsal: "staging-paid-hybrid",
    tag: state.tag,
    createdAt: state.createdAt,
    updatedAt: new Date().toISOString(),
    market: MARKET,
    roles,
    store: state.store ?? null,
    trade: {
      intentId: state.trade.intentId ?? null,
      productId: state.trade.productId ?? null,
      cartId: state.trade.cartId ?? null,
      quote: state.trade.quote ?? null,
      txRef: state.trade.txRef ?? null,
      charge: state.trade.charge ?? null,
      hold: state.trade.hold ?? null,
      holdCount: state.trade.holdCount ?? null,
      checkout: state.trade.checkout ?? null,
    },
    run: {
      runId: state.trade.checkout?.runId ?? null,
      claimed: state.run.claimed === true,
      pickup: state.run.pickup ?? null,
      delivery: state.run.delivery ?? null,
      finalDeliveryAt: state.run.finalDeliveryAt ?? null,
    },
    settlement: state.settlement ?? null,
    verification: state.verification ?? null,
    ...(failure ? { failure: redactText(failure) } : state.failure ? { failure: state.failure } : {}),
  };
  fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(safe(evidence), null, 2));
}

function log(message) {
  console.log(redactText(message));
}

function fail(label, response) {
  const body = response?.json !== null && response?.json !== undefined
    ? JSON.stringify(safe(response.json)).slice(0, 1800)
    : "non-JSON response";
  throw new Error(`${label}: HTTP ${response?.status ?? 0} ${redactText(body)}`);
}

function assertResponse(label, response, expected, predicate = () => true) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  if (!statuses.includes(response.status) || !predicate(response.json)) fail(label, response);
  log(`PASS ${label} (HTTP ${response.status})`);
  return response.json;
}

async function request(method, url, { role, body, raw, headers = {}, timeoutMs = 60_000 } = {}) {
  const auth = role ? { authorization: `Bearer ${state.roles[role].session.token}` } : {};
  const init = { method, headers: { ...auth, ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    return { status: 0, json: null, text: redactText(error?.message ?? error) };
  }
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* status is sufficient for non-JSON failures */ }
  return { status: response.status, json, text, headers: response.headers };
}

const participantRequest = (role, method, route, options = {}) =>
  request(method, `${edge}${route}`, { ...options, role });
const command = (role, body) => participantRequest(role, "POST", "/command", { body });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let image;
let frames;
async function biometricPayload() {
  if (!image) {
    const source = fs.readFileSync(IMAGE_PATH);
    image = await sharp(source).jpeg({ quality: 92 }).toBuffer();
    frames = [image];
    for (let index = 1; index < 7; index += 1) {
      frames.push(await sharp(source).modulate({ brightness: 1 + index * 0.015, saturation: 1 + index * 0.01 }).jpeg({ quality: 92 }).toBuffer());
    }
  }
  return {
    image: image.toString("base64"),
    livenessImages: frames.map((frame) => frame.toString("base64")),
    consent: { version: "biometric-capture-v2", granted: true, grantedAt: Date.now() },
  };
}

async function verifyRole(roleName) {
  const role = state.roles[roleName];
  if (role.session?.token && role.session.expiresAt > Date.now() + 60_000) return;
  const biometrics = await biometricPayload();
  const verified = await participantRequest(roleName, "POST", "/auth/face/verify", {
    body: { participantId: role.participantId, ...biometrics },
    timeoutMs: 90_000,
  });
  // Verification is intentionally unauthenticated; participantRequest is not used here.
  void verified;
}

async function faceVerify(roleName) {
  const role = state.roles[roleName];
  if (role.session?.token && role.session.expiresAt > Date.now() + 60_000) return;
  const response = await request("POST", `${edge}/auth/face/verify`, {
    body: { participantId: role.participantId, ...(await biometricPayload()) },
    timeoutMs: 90_000,
  });
  const body = assertResponse(`${roleName} local face verification issued a Bearer session`, response, 200,
    (json) => typeof json?.session?.token === "string");
  role.session = body.session;
  saveState();
}

async function enrollRole(roleName) {
  const role = state.roles[roleName];
  if (!role.onboarded) {
    const response = await request("POST", `${edge}/command`, {
      body: {
        type: "participant.onboarded",
        participantId: role.participantId,
        role: roleName,
        displayName: `Paid ${roleName} ${state.tag}`,
        email: role.email,
        consentAt: Date.now(),
        consentVersion: "kyc-onboarding-v1",
        idDocumentType: "bvn",
        idDocument: "00000000000",
        market: MARKET,
      },
      timeoutMs: 90_000,
    });
    const body = assertResponse(`${roleName} BVN onboarding issued enrollment proof`, response, 200,
      (json) => typeof json?.enrollmentProof === "string");
    role.enrollmentProof = body.enrollmentProof;
    role.onboarded = true;
    saveState();
  }
  if (!role.jobId) {
    const response = await request("POST", `${edge}/auth/face/enroll`, {
      body: {
        participantId: role.participantId,
        enrollmentProof: role.enrollmentProof,
        ...(await biometricPayload()),
        userDetails: { givenNames: "Amina Fatou", lastName: "Clearwater", email: "amina.clearwater@example.com" },
        identityDocument: { country: "NG", idType: "BVN", idNumber: "00000000000" },
      },
      timeoutMs: 120_000,
    });
    const body = assertResponse(`${roleName} hybrid enrollment accepted`, response, 202,
      (json) => typeof json?.jobId === "string");
    role.jobId = body.jobId;
    saveState();
    log(`${roleName} Smile ID jobId=${role.jobId}`);
  }
  if (!role.enrolled) {
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      const response = await request("GET", `${edge}/auth/face/job/${encodeURIComponent(role.jobId)}`);
      if (response.status === 200 && response.json?.status === "complete") {
        role.enrolled = true;
        saveState();
        log(`${roleName} hybrid job complete jobId=${role.jobId}`);
        break;
      }
      if (response.status !== 200 || response.json?.status !== "pending") fail(`${roleName} hybrid job ${role.jobId}`, response);
      if (Date.now() >= deadline) throw new Error(`${roleName} hybrid job ${role.jobId} did not complete within 10 minutes`);
      await sleep(4_000);
    }
  }
  await faceVerify(roleName);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const profile = await participantRequest(roleName, "GET", `/participants/${encodeURIComponent(role.participantId)}`);
    if (profile.status === 200 && profile.json?.participant?.kycStatus === "verified") {
      role.kycStatus = "verified";
      saveState();
      break;
    }
    if (Date.now() >= deadline) fail(`${roleName} core KYC reconciliation`, profile);
    await sleep(2_000);
  }
  log(`${roleName} core KYC verified participantId=${role.participantId}`);
}

async function joinMarket(roleName) {
  const role = state.roles[roleName];
  if (role.marketJoined) return;
  const response = await command(roleName, {
    type: "market.joined", market: MARKET, participantId: role.participantId, role: roleName,
  });
  assertResponse(`${roleName} joined ${MARKET}`, response, 200, (json) => json?.type === "market.member-recorded");
  role.marketJoined = true;
  saveState();
}

async function savePayout(roleName) {
  const role = state.roles[roleName];
  if (role.payoutAccount) return;
  const input = { bankCode: "044", accountNumber: "0690000031" };
  const resolved = await participantRequest(roleName, "POST", "/payments/payout-accounts/resolve", { body: input });
  assertResponse(`${roleName} TEST payout account resolved`, resolved, 200,
    (json) => json?.bankCode === input.bankCode && json?.accountNumber === input.accountNumber && typeof json?.accountName === "string");
  const saved = await participantRequest(roleName, "POST", "/payments/payout-accounts", {
    body: { participantId: role.participantId, ...input },
  });
  const account = assertResponse(`${roleName} TEST payout account saved`, saved, 200,
    (json) => json?.participantId === role.participantId && json?.revokedAt === null);
  role.payoutAccount = { bankCode: account.bankCode, accountLast4: account.accountNumber.slice(-4), accountName: account.accountName };
  saveState();
}

async function setup() {
  for (const [name, url] of [["edge", `${edge}/healthz`], ["payments", `${process.env.PAYMENTS_PUBLIC_URL}/healthz`]]) {
    const response = await request("GET", url);
    assertResponse(`${name} staging health`, response, 200, (json) => json?.ok === true);
  }
  await enrollRole("seller");
  await enrollRole("runner");
  if (REUSE_BUYER) {
    await faceVerify("buyer");
    state.roles.buyer.kycStatus = "verified";
    saveState();
  } else {
    await enrollRole("buyer");
  }
  await joinMarket("seller");
  await joinMarket("runner");
  await joinMarket("buyer");
  await savePayout("seller");
  await savePayout("runner");
  if (!state.store) {
    const response = await command("seller", {
      type: "store.registered",
      storeId: `store-paid-${state.tag}`,
      market: MARKET,
      name: `Amina Paid Tomatoes ${state.tag}`,
      exchangePoint: STORE_POINT,
      shopItems: [STORE_ITEM],
    });
    const body = assertResponse("seller registered Balogun Stall B14 tomatoes store", response, 200,
      (json) => json?.store?.exchangePoint === STORE_POINT && json?.store?.shopItems?.includes(STORE_ITEM));
    state.store = body.store;
    saveState();
  }
}

async function flutterwave(method, route, body) {
  return request(method, `https://api.flutterwave.com${route}`, {
    ...(body === undefined ? {} : { body }),
    headers: { authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` },
    timeoutMs: 90_000,
  });
}

function chargeSummary(body) {
  const data = body?.data ?? {};
  return {
    providerTxId: data.id === undefined ? null : String(data.id),
    txRef: data.tx_ref ?? null,
    providerStatus: data.status ?? null,
    amountKobo: Number.isFinite(Number(data.amount)) ? Math.round(Number(data.amount) * 100) : null,
    currency: data.currency ?? null,
    paymentMethod: data.payment_type ?? null,
  };
}

async function verifyProviderCharge() {
  const charge = state.trade.charge;
  const route = charge.providerTxId
    ? `/v3/transactions/${encodeURIComponent(charge.providerTxId)}/verify`
    : `/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(state.trade.txRef)}`;
  const response = await flutterwave("GET", route);
  if (response.status !== 200 || response.json?.status !== "success") return null;
  return chargeSummary(response.json);
}

async function createRealCharge(buyer) {
  if (!state.trade.txRef) {
    state.trade.txRef = `mr-paid-${state.tag}`;
    saveState();
  }
  if (state.trade.charge?.providerStatus === "successful") return;
  if (state.trade.charge?.initiatedAt && !state.trade.charge?.providerTxId) {
    const existing = await verifyProviderCharge();
    if (!existing?.providerTxId) {
      throw new Error(`a prior charge attempt is unresolved for txRef ${state.trade.txRef}; refusing to create a duplicate`);
    }
    state.trade.charge = { ...state.trade.charge, ...existing };
    saveState();
  }
  if (!state.trade.charge?.initiatedAt) {
    state.trade.charge = { initiatedAt: new Date().toISOString() };
    saveState();
    const payload = {
      card_number: "5531886652142950",
      cvv: "564",
      expiry_month: "09",
      expiry_year: "32",
      currency: "NGN",
      amount: state.trade.quote.totalKobo / 100,
      email: buyer.email,
      fullname: "Amina Fatou Clearwater",
      tx_ref: state.trade.txRef,
      meta: { cartId: state.trade.cartId, buyerId: buyer.participantId },
    };
    let response = await flutterwave("POST", "/v3/charges?type=card", payload);
    if (response.json?.status !== "success") fail("Flutterwave direct card initiation", response);
    let mode = response.json?.meta?.authorization?.mode;
    if (mode === "pin") {
      response = await flutterwave("POST", "/v3/charges?type=card", {
        ...payload,
        authorization: { mode: "pin", pin: "3310" },
      });
      if (response.json?.status !== "success") fail("Flutterwave direct card PIN authorization", response);
      mode = response.json?.meta?.authorization?.mode;
    }
    const summary = chargeSummary(response.json);
    state.trade.charge = {
      ...state.trade.charge,
      ...summary,
      providerFlwRef: response.json?.data?.flw_ref ?? null,
      authorizationMode: mode ?? null,
    };
    saveState();
    if (mode === "otp") {
      const validated = await flutterwave("POST", "/v3/validate-charge", {
        otp: "12345", flw_ref: state.trade.charge.providerFlwRef,
      });
      if (validated.json?.status !== "success") fail("Flutterwave OTP validation", validated);
      state.trade.charge = { ...state.trade.charge, ...chargeSummary(validated.json), authorizationMode: "otp-validated" };
      saveState();
    } else if (mode === "redirect") {
      throw new Error("direct card charge requires a hosted redirect; no redirect was followed or bypassed");
    }
  }
  const deadline = Date.now() + 90_000;
  for (;;) {
    const verified = await verifyProviderCharge();
    if (verified?.providerStatus === "successful") {
      if (verified.txRef !== state.trade.txRef || verified.amountKobo !== state.trade.quote.totalKobo || verified.currency !== "NGN") {
        throw new Error(`provider charge does not match quote/txRef: ${JSON.stringify(safe(verified))}`);
      }
      state.trade.charge = { ...state.trade.charge, ...verified };
      saveState();
      log(`PASS real Flutterwave TEST charge successful txRef=${state.trade.txRef} transactionId=${verified.providerTxId} amountKobo=${verified.amountKobo}`);
      return;
    }
    if (verified && !["pending", null].includes(verified.providerStatus)) {
      throw new Error(`provider charge terminal status ${verified.providerStatus} for txRef ${state.trade.txRef}`);
    }
    if (Date.now() >= deadline) throw new Error(`provider charge remained pending for txRef ${state.trade.txRef}`);
    await sleep(5_000);
  }
}

const require = createRequire(new URL("../apps/payments/package.json", import.meta.url));
const postgres = require("postgres");
let sql;
function database() {
  if (!sql) sql = postgres(process.env.DATABASE_URL, { max: 2, types: { bigint: postgres.BigInt } });
  return sql;
}

async function trade() {
  if (!state.store || !state.roles.seller.session || !state.roles.runner.session || !state.roles.buyer.session) {
    throw new Error("setup is incomplete; run --phase=setup first");
  }
  const buyer = state.roles.buyer;
  if (!state.trade.intentId) {
    const intentId = `intent-paid-${state.tag}`;
    const response = await command("buyer", {
      type: "intent.posted",
      intentId,
      shopItem: STORE_ITEM,
      quantity: 1,
      unit: "basket",
      priceBand: { minKobo: 120_000, maxKobo: 180_000 },
      note: `Paid staging rehearsal ${state.tag}`,
      market: MARKET,
    });
    assertResponse("buyer posted matching tomatoes intent", response, 200,
      (json) => json?.intent?.id === intentId && json?.intent?.status === "open");
    state.trade.intentId = intentId;
    saveState();
  }
  if (!state.trade.productId) {
    const productId = `product-paid-${state.tag}`;
    const response = await participantRequest("seller", "POST", `/markets/${MARKET}/offers`, {
      body: {
        productId,
        intentId: state.trade.intentId,
        market: MARKET,
        shopItem: STORE_ITEM,
        quantity: 1,
        unit: "basket",
        priceKobo: 165_000,
        storeId: state.store.id,
        sellerName: state.store.name,
        sellerParticipantId: state.roles.seller.participantId,
        exchangePoint: STORE_POINT,
      },
    });
    assertResponse("seller offered tomatoes from owned store", response, 200,
      (json) => json?.product?.id === productId && json?.product?.status === "available");
    state.trade.productId = productId;
    saveState();
  }
  if (!state.trade.cartId) {
    const response = await command("buyer", { type: "product.accepted", productId: state.trade.productId });
    const body = assertResponse("buyer accepted offer into cart", response, 200,
      (json) => typeof json?.cart?.id === "string" && json?.cart?.status === "open");
    state.trade.cartId = body.cart.id;
    saveState();
  }
  if (!state.trade.quote || state.trade.quote.expiresAt < Date.now() + 30_000) {
    if (state.trade.txRef && state.trade.charge?.providerStatus !== "successful") {
      throw new Error("quote expired while a charge was unresolved; refusing to reprice or duplicate the collection");
    }
    const response = await participantRequest("buyer", "POST", `/markets/${MARKET}/cart/quote`, { body: { delivery: DELIVERY } });
    const quote = assertResponse("server issued exact collection quote", response, 200,
      (json) => json?.cartId === state.trade.cartId && Number.isInteger(json?.totalKobo));
    if (state.trade.charge?.providerStatus === "successful" && quote.totalKobo !== state.trade.charge.amountKobo) {
      throw new Error(`fresh quote ${quote.totalKobo} kobo differs from successful charge ${state.trade.charge.amountKobo} kobo`);
    }
    state.trade.quote = quote;
    saveState();
    log(`quoteId=${quote.quoteId} cartId=${quote.cartId} goodsKobo=${quote.goodsKobo} deliveryKobo=${quote.deliveryKobo} totalKobo=${quote.totalKobo}`);
  }
  await createRealCharge(buyer);
  if (!state.trade.hold) {
    const input = {
      txRef: state.trade.txRef,
      transactionId: state.trade.charge.providerTxId,
      expectedAmountKobo: state.trade.quote.totalKobo,
      buyerId: buyer.participantId,
      cartId: state.trade.cartId,
    };
    const response = await participantRequest("buyer", "POST", "/payments/charges/confirm", { body: input });
    const hold = assertResponse("payments confirmed provider charge and placed hold", response, 200,
      (json) => typeof json?.holdId === "string" && json?.status === "held" && json?.amountKobo === state.trade.quote.totalKobo);
    const replay = await participantRequest("buyer", "POST", "/payments/charges/confirm", { body: input });
    assertResponse("charge confirmation is idempotent", replay, 200, (json) => json?.holdId === hold.holdId);
    state.trade.hold = hold;
    saveState();
  }
  if (state.trade.holdCount === undefined) {
    const rows = await database()`SELECT id, tx_ref, status, amount_kobo FROM payment_holds WHERE tx_ref = ${state.trade.txRef}`;
    if (rows.length !== 1 || rows[0].id !== state.trade.hold.holdId || rows[0].status !== "held") {
      throw new Error(`expected exactly one durable hold for ${state.trade.txRef}; found ${rows.length}`);
    }
    state.trade.holdCount = rows.length;
    saveState();
    log(`PASS exactly one hold holdId=${state.trade.hold.holdId} status=held`);
  }
  if (!state.trade.checkout) {
    const response = await command("buyer", {
      type: "checkout.requested",
      cartId: state.trade.cartId,
      delivery: DELIVERY,
      quoteId: state.trade.quote.quoteId,
      paymentRef: state.trade.txRef,
    });
    const checkout = assertResponse("paid checkout accepted and run issued", response, 200,
      (json) => json?.type === "checkout.accepted" && json?.cartId === state.trade.cartId && typeof json?.runId === "string");
    state.trade.checkout = checkout;
    saveState();
    log(`runId=${checkout.runId}`);
  }
}

async function updateLocation(latitude, longitude) {
  const runId = state.trade.checkout.runId;
  const response = await command("runner", {
    type: "run.location-updated", runId, latitude, longitude, accuracyMeters: 10, observedAt: Date.now(),
  });
  assertResponse("runner published fresh in-perimeter location", response, 200, (json) => json?.type === "run.updated");
}

async function capture(runId) {
  const response = await participantRequest("runner", "POST", "/captures", {
    raw: fs.readFileSync(IMAGE_PATH),
    headers: { "content-type": "image/png", "x-run-id": runId },
  });
  const body = assertResponse("runner uploaded real capture through evidence seam", response, 200,
    (json) => typeof json?.ref === "string" && json.ref.startsWith("r2://archive/captures/"));
  return body.ref;
}

async function handoffs() {
  const runId = state.trade.checkout?.runId;
  if (!runId) throw new Error("trade is incomplete; run --phase=trade first");
  if (!state.run.claimed) {
    const response = await participantRequest("runner", "POST", `/runs/${encodeURIComponent(runId)}/claim`, {
      body: { location: { latitude: 6.4541, longitude: 3.3947, accuracyMeters: 10, observedAt: Date.now() } },
    });
    assertResponse("runner atomically claimed unassigned run", response, 200, (json) => json?.runnerId === state.roles.runner.participantId);
    state.run.claimed = true;
    saveState();
  }
  const runResponse = await participantRequest("runner", "GET", `/runs/${encodeURIComponent(runId)}`);
  const runBody = assertResponse("runner read claimed run", runResponse, 200, (json) => json?.run?.stops?.length === 1);
  const run = runBody.run;
  const stop = run.stops[0];
  state.run.pickup ??= { handoffId: `handoff-paid-${state.tag}-pickup` };
  state.run.delivery ??= { handoffId: `handoff-paid-${state.tag}-delivery` };
  saveState();
  if (!state.run.pickup.initiated) {
    const response = await participantRequest("runner", "POST", `/runs/${encodeURIComponent(runId)}/handoffs`, {
      body: {
        handoffId: state.run.pickup.handoffId,
        handoffType: "pickup",
        exchangePointId: stop.exchangePoint,
        counterparty: stop.sellerName,
      },
    });
    assertResponse("pickup handoff opened", response, 200, (json) => json?.type === "handoff.initiated");
    state.run.pickup.initiated = true;
    saveState();
  }
  if (!state.run.pickup.photolessRejected) {
    const challengeResponse = await participantRequest("seller", "GET",
      `/runs/${encodeURIComponent(runId)}/handoffs/${encodeURIComponent(state.run.pickup.handoffId)}/challenge`);
    const challenge = assertResponse("seller read pickup QR challenge", challengeResponse, 200,
      (json) => typeof json?.challenge === "string").challenge;
    const scanned = await command("runner", {
      type: "handoff.challenge-scanned", handoffId: state.run.pickup.handoffId, runId, challenge,
    });
    assertResponse("photoless pickup rejected with photo-required", scanned, 409, (json) => json?.error === "photo-required");
    state.run.pickup.photolessRejected = true;
    saveState();
  }
  if (!state.run.pickup.confirmed) {
    await updateLocation(stop.location?.latitude ?? 6.4544, stop.location?.longitude ?? 3.3949);
    const ref = await capture(runId);
    const response = await participantRequest("runner", "POST",
      `/runs/${encodeURIComponent(runId)}/handoffs/${encodeURIComponent(state.run.pickup.handoffId)}/photo`, {
        body: { type: "handoff.photo-captured", handoffId: state.run.pickup.handoffId, photoCaptureRef: ref },
      });
    assertResponse("pickup photo attached and pickup confirmed", response, 200, (json) =>
      json?.run?.handoffs?.find((handoff) => handoff.id === state.run.pickup.handoffId)?.status === "confirmed");
    state.run.pickup = { ...state.run.pickup, confirmed: true, photoCaptureRef: ref };
    saveState();
  }
  if (!state.run.delivery.initiated) {
    const response = await participantRequest("runner", "POST", `/runs/${encodeURIComponent(runId)}/handoffs`, {
      body: {
        handoffId: state.run.delivery.handoffId,
        handoffType: "delivery",
        exchangePointId: run.delivery.kind === "plus-code" ? run.delivery.plusCode : run.delivery.name,
        counterparty: state.roles.buyer.participantId,
      },
    });
    assertResponse("delivery handoff opened", response, 200, (json) => json?.type === "handoff.initiated");
    state.run.delivery.initiated = true;
    saveState();
  }
  if (!state.run.delivery.codeVerified) {
    const codeResponse = await participantRequest("buyer", "GET", `/runs/${encodeURIComponent(runId)}/delivery-code`);
    const code = assertResponse("buyer delivery code issued", codeResponse, 200,
      (json) => typeof json?.code === "string" && /^\d{6}$/.test(json.code)).code;
    state.run.delivery.deliveryCode = code;
    saveState();
    const scanned = await command("runner", {
      type: "handoff.challenge-scanned", handoffId: state.run.delivery.handoffId, runId, challenge: code,
    });
    assertResponse("delivery code verified before photo", scanned, 200, (json) => json?.type === "handoff.challenge-verified");
    state.run.delivery.codeVerified = true;
    delete state.run.delivery.deliveryCode;
    saveState();
  }
  if (!state.run.delivery.photoCaptureRef) {
    const ref = await capture(runId);
    const response = await participantRequest("runner", "POST",
      `/runs/${encodeURIComponent(runId)}/handoffs/${encodeURIComponent(state.run.delivery.handoffId)}/photo`, {
        body: { type: "handoff.photo-captured", handoffId: state.run.delivery.handoffId, photoCaptureRef: ref },
      });
    assertResponse("fresh delivery photo attached after code verification", response, 200, (json) =>
      json?.run?.handoffs?.find((handoff) => handoff.id === state.run.delivery.handoffId)?.photoCaptureRef === ref);
    state.run.delivery.photoCaptureRef = ref;
    saveState();
  }
  if (!state.run.delivery.confirmed) {
    const destination = run.route?.destination ?? { latitude: 6.4556, longitude: 3.3962 };
    await updateLocation(destination.latitude, destination.longitude);
    const response = await participantRequest("buyer", "POST",
      `/runs/${encodeURIComponent(runId)}/handoffs/${encodeURIComponent(state.run.delivery.handoffId)}/confirm`, { body: {} });
    assertResponse("buyer explicitly confirmed code plus photo delivery", response, 200,
      (json) => json?.type === "handoff.confirmed" && json?.autoConfirmed === false);
    state.run.delivery.confirmed = true;
    saveState();
  }
  if (!state.run.finalDeliveryAt) {
    const destination = run.route?.destination ?? { latitude: 6.4556, longitude: 3.3962 };
    await updateLocation(destination.latitude, destination.longitude);
    const response = await participantRequest("runner", "POST", `/runs/${encodeURIComponent(runId)}/delivery/final`, { body: {} });
    const body = assertResponse("final delivery stamped and dispute window armed", response, 200,
      (json) => json?.run?.status === "delivered" && Number.isInteger(json?.run?.finalDeliveryAt));
    state.run.finalDeliveryAt = body.run.finalDeliveryAt;
    saveState();
  }
}

async function opsSignIn() {
  if (state.opsCookie) return;
  const response = await request("POST", `${edge}/ops/auth/sign-in/email`, {
    body: { email: process.env.OPS_ADMIN_EMAIL, password: process.env.OPS_ADMIN_PASSWORD },
    headers: { origin: edge },
  });
  const cookies = response.headers?.getSetCookie?.().map((value) => value.split(";")[0]) ?? [];
  if (response.status !== 200 || cookies.length === 0) fail("operator admin sign-in", response);
  state.opsCookie = cookies.join("; ");
  saveState();
  const session = await request("GET", `${edge}/ops/auth/get-session`, { headers: { cookie: state.opsCookie } });
  assertResponse("operator admin session valid", session, 200,
    (json) => json?.user?.role === "admin" && json?.user?.mustChangePassword === false);
}

async function settleAndVerify() {
  const runId = state.trade.checkout?.runId;
  if (!state.run.finalDeliveryAt) throw new Error("handoffs are incomplete; run --phase=handoffs first");
  // A pre-populated automatic settlement skips both ops sign-in and ops settle.
  if (!state.settlement) await opsSignIn();
  if (!state.settlement) {
    const response = await request("POST", `${edge}/ops/api/runs/${encodeURIComponent(runId)}/settle`, {
      body: { mode: "completed", reason: `Paid staging rehearsal ${state.tag}: explicit code/photo delivery confirmed` },
      headers: { cookie: state.opsCookie },
    });
    const body = assertResponse("ops completed settlement", response, 200,
      (json) => json?.adjusted === true && json?.settlement?.type === "settlement.released" && json?.settlement?.mode === "completed");
    if (body.settlement.buyerRefundKobo !== 0) throw new Error("completed rehearsal unexpectedly produced a buyer refund");
    state.settlement = {
      settlementRecordId: `${runId}:settlement`,
      response: body.settlement,
    };
    saveState();
  }
  const db = database();
  const recordId = state.settlement.settlementRecordId;
  let record;
  const recordDeadline = Date.now() + 120_000;
  for (;;) {
    const rows = await db`SELECT id, run_id, mode, runner_kobo, platform_kobo, buyer_refund_kobo FROM settlement_records WHERE id = ${recordId}`;
    if (rows.length === 1) { record = rows[0]; break; }
    if (Date.now() >= recordDeadline) throw new Error(`settlement record ${recordId} did not archive within 120 seconds`);
    await sleep(2_000);
  }
  const released = state.settlement.response;
  if (record.run_id !== runId || record.mode !== "completed" || Number(record.runner_kobo) !== released.runnerKobo ||
      Number(record.platform_kobo) !== released.platformKobo || Number(record.buyer_refund_kobo) !== 0) {
    throw new Error(`durable settlement ${recordId} does not match the released outcome`);
  }
  const expected = [
    ...released.sellers.filter((seller) => seller.amountKobo > 0).map((seller) => ({ account: "seller", partyId: seller.sellerId, amountKobo: seller.amountKobo })),
    ...(released.runnerKobo > 0 ? [{ account: "runner", partyId: released.runnerId, amountKobo: released.runnerKobo }] : []),
    ...(released.platformKobo > 0 ? [{ account: "platform", partyId: "platform", amountKobo: released.platformKobo }] : []),
  ];
  let dispatches = [];
  const dispatchDeadline = Date.now() + 120_000;
  for (;;) {
    dispatches = await db`SELECT id, idempotency_key, account, party_id, amount_kobo, status, attempts, provider_ref, provider_reference, failure_reason
      FROM payment_dispatches WHERE settlement_record_id = ${recordId} ORDER BY id`;
    if (dispatches.length === expected.length && dispatches.every((row) => Number(row.attempts) >= 1)) break;
    if (Date.now() >= dispatchDeadline) break;
    await sleep(2_000);
  }
  const summaries = dispatches.map((row) => ({
    id: row.id,
    idempotencyKey: row.idempotency_key,
    account: row.account,
    partyId: row.party_id,
    amountKobo: Number(row.amount_kobo),
    status: row.status,
    attempts: Number(row.attempts),
    providerRef: row.provider_ref,
    providerReference: row.provider_reference,
    failureReason: row.failure_reason,
  }));
  for (const leg of expected) {
    const matches = summaries.filter((row) => row.account === leg.account && row.partyId === leg.partyId && row.amountKobo === leg.amountKobo);
    if (matches.length !== 1) throw new Error(`expected exactly one ${leg.account} dispatch for ${leg.partyId}; found ${matches.length}`);
    if (!["queued", "sent", "completed"].includes(matches[0].status) || matches[0].attempts < 1) {
      throw new Error(`${leg.account} dispatch ${matches[0].id} not accepted cleanly: ${JSON.stringify(matches[0])}`);
    }
  }
  let hold;
  const holdDeadline = Date.now() + 60_000;
  for (;;) {
    const rows = await db`SELECT id, tx_ref, run_id, status, amount_kobo FROM payment_holds WHERE tx_ref = ${state.trade.txRef}`;
    if (rows.length === 1 && rows[0].status === "released") { hold = rows[0]; break; }
    if (Date.now() >= holdDeadline) {
      throw new Error(`hold was not released after accepted dispatches: ${JSON.stringify(safe(rows))}`);
    }
    await sleep(2_000);
  }
  if (hold.id !== state.trade.hold.holdId || hold.run_id !== runId || Number(hold.amount_kobo) !== state.trade.quote.totalKobo) {
    throw new Error(`released hold ${hold.id} does not match cart/run/quote`);
  }
  const refunds = await db`SELECT count(*)::int AS count FROM payment_refunds WHERE settlement_record_id = ${recordId}`;
  if (refunds[0].count !== 0) throw new Error(`completed settlement unexpectedly has ${refunds[0].count} refund rows`);
  state.verification = {
    settlementRecordId: recordId,
    durableSettlement: { id: record.id, runId: record.run_id, mode: record.mode },
    dispatches: summaries,
    hold: { id: hold.id, txRef: hold.tx_ref, runId: hold.run_id, status: hold.status, amountKobo: Number(hold.amount_kobo) },
    refundCount: 0,
  };
  saveState();
  log(`PASS settlement ${recordId}; hold ${hold.id} released; ${summaries.length} dispatch legs accepted`);
  for (const row of summaries) log(`dispatch ${row.account} id=${row.id} status=${row.status} attempts=${row.attempts} amountKobo=${row.amountKobo}`);

  const child = spawnSync(process.execPath, [
    RECONCILE_PATH,
    "--json",
    `--market=${MARKET}`,
    `--provider-since=${process.env.RECONCILE_PROVIDER_SINCE}`,
  ], { encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024 });
  const stdout = child.stdout ?? "";
  const lines = stdout.trimEnd().split("\n");
  const exitLine = lines.at(-1) ?? "";
  let report;
  try { report = JSON.parse(lines.slice(0, -1).join("\n")); }
  catch { throw new Error(`reconciliation output was not parseable; exit=${child.status} ${redactText(child.stderr ?? "")}`); }
  const checks = report.checks.map((check) => ({
    name: check.name,
    status: check.status,
    counts: check.counts,
    discrepancies: check.discrepancies,
    warnings: check.warnings,
  }));
  state.verification.reconciliation = {
    ok: report.ok,
    exitCode: child.status,
    exitLine,
    providerBaseline: process.env.RECONCILE_PROVIDER_SINCE,
    checks,
  };
  saveState();
  for (const check of checks) log(`reconcile ${check.name}: ${check.status} ${JSON.stringify(check.counts)} warnings=${check.warnings.length} failures=${check.discrepancies.length}`);
  if (child.status !== 0 || report.ok !== true || checks.some((check) => check.status !== "PASS")) {
    throw new Error("reconciliation produced a FAIL or WARN; see evidence.json");
  }
  log("PASS reconciliation has zero FAIL and zero WARN");
}

try {
  saveState();
  if (phase === "setup" || phase === "all") await setup();
  if (phase === "trade" || phase === "all") await trade();
  if (phase === "handoffs" || phase === "all") await handoffs();
  if (phase === "settle" || phase === "all") await settleAndVerify();
  delete state.failure;
  saveState();
  log(`REHEARSAL_PHASE_PASS=${phase} tag=${state.tag}`);
  log(`evidence=${EVIDENCE_PATH}`);
} catch (error) {
  state.failure = redactText(error?.message ?? error);
  saveState();
  console.error(`REHEARSAL_PHASE_FAIL=${phase} tag=${state.tag}: ${state.failure}`);
  console.error(`participantIds=${Object.values(state.roles).map((role) => role.participantId).join(",")}`);
  console.error(`jobIds=${Object.values(state.roles).map((role) => role.jobId).filter(Boolean).join(",") || "none"}`);
  console.error(`txRef=${state.trade.txRef ?? "none"} holdId=${state.trade.hold?.holdId ?? "none"} cartId=${state.trade.cartId ?? "none"} runId=${state.trade.checkout?.runId ?? "none"}`);
  console.error(`evidence=${EVIDENCE_PATH}`);
  process.exitCode = 1;
} finally {
  if (sql) await sql.end({ timeout: 5 });
}
