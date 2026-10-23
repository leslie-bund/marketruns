#!/usr/bin/env node
/**
 * e2e-session.mjs — scripted rehearsal of the runbook's money scenarios
 * (docs/runbooks/first-live-test.md §4): S3 (dispute at delivery → ops settle,
 * disputed mode) and S4 (abort → partial settle, ADR-0008), played over the
 * REAL HTTP wire against the running dev stack, then proven in Postgres and
 * tied out by infra/reconcile.mjs.
 *
 * Doctrine under test:
 *   - Handoffs confirm only with photo evidence (ADR-0020): the photoless QR
 *     scan is refused 409 photo-required; attaching the photo IS the confirm.
 *   - Money moves only through the settlement function (ADR-0007): ops settle
 *     picks a mode and a reason; the kobo outcome must equal the domain split
 *     for the echoed SettlementInput.
 *   - Aborts never refund fully (ADR-0008): buyerRefundKobo < captured total.
 *   - Dispute evidence merges server-side (ADR-0019): the disputes row
 *     materializes at run retirement carrying every handoff photo ref.
 *
 * Requires the dev stack ALREADY running:  npx pnpm@9.15.4 dev:all
 * (edge :8787 + the Postgres container, migrated, with the demo seed). Runs
 * against the unpaid dev checkout posture (PAYMENTS_REQUIRED unset): a gated
 * edge refuses this script's checkout — that is an environment failure (exit
 * 2), not a product bug.
 *
 * Idempotent: every invocation uses fresh participant/object ids
 * (`buyer:e2e-s3-<ts>` etc.), so re-runs never collide with retired carts.
 *
 * Usage:
 *   node infra/e2e-session.mjs [--edge http://localhost:8787]
 *
 * Env (existing shell values win over infra/.dev.vars, which is loaded when present):
 *   EDGE_URL      edge base URL (default http://localhost:8787; --edge wins)
 *   PAYMENTS_URL  payments worker base URL (default http://localhost:8790)
 *   DATABASE_URL  dev Postgres (default postgres://postgres:postgres@localhost:54322/market_runs)
 *   OPS_TOKEN     forwarded as x-ops-token when the edge guards ops routes
 *   PAYMENT_DISPATCHER / FLUTTERWAVE_*  reported in preflight; the vendor key
 *                 is inherited by the reconcile child
 *
 * Exit: 0 pass · 1 assertion failure · 2 environment/usage failure.
 * The last line is always E2E_SESSION_EXIT=<code> (RECONCILE_EXIT-style).
 *
 * Dependencies: `postgres` only (resolved from apps/payments — a workspace dep).
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { loadDevVars } from "./dev-vars.mjs";

// The workers read infra/.dev.vars; the Node scripts must see the same
// dispatcher/vendor posture (and pass the key to the reconcile child).
loadDevVars();

// infra/ has no package.json; resolve the workspace dep from apps/payments.
const require = createRequire(new URL("../apps/payments/package.json", import.meta.url));
const postgres = require("postgres");

const RECONCILE_SCRIPT = fileURLToPath(new URL("./reconcile.mjs", import.meta.url));
const DEFAULT_EDGE = "http://localhost:8787";
const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:54322/market_runs";
const MARKET = "Balogun";
/** How far ahead the ops config lever rolls closeAt when the close gate would refuse checkout. */
const MARKET_OPEN_ROLL_MS = 8 * 60 * 60 * 1000;
/** Archive + payments consumers land in well under this in dev; the poll bound keeps CI honest. */
const DB_POLL_MS = 30_000;

const RUNNER_ID = "runner:internal";

/** Demo-seed fixtures (infra/seed-demo.mjs): the stores this rehearsal trades with. */
const S3_STORE = {
  sellerId: "participant:demo-amina",
  sellerName: "Amina's Fresh Store",
  exchangePoint: "Balogun Market, Stall B14",
  shopItem: "Tomatoes (basket)",
  quantity: 2,
  unit: "basket",
  priceBand: { minKobo: 120_000, maxKobo: 180_000 },
  priceKobo: 165_000,
};
const S4_STORE = {
  sellerId: "participant:demo-ngozi",
  sellerName: "Mama Ngozi Provisions",
  exchangePoint: "Balogun Market, Line C, Stall C7",
  shopItem: "Rice (50kg bag)",
  quantity: 1,
  unit: "bag",
  priceBand: { minKobo: 2_300_000, maxKobo: 2_600_000 },
  priceKobo: 2_450_000,
};
/** Camera evidence: a real 1×1 PNG through POST /captures — the only way to mint a signed r2:// ref. */
const PIXEL_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const opts = { edge: (process.env.EDGE_URL ?? DEFAULT_EDGE).replace(/\/$/, ""), help: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--edge" && argv[i + 1]) {
      opts.edge = argv[i + 1].replace(/\/$/, "");
      i += 1;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      opts.help = true;
    } else {
      console.error(`unknown argument: ${argv[i]} (see --help)`);
      process.exit(2);
    }
  }
  return opts;
}

/* ------------------------------------------------------------- scorekeeping */

let passed = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
  return ok;
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

/** Environment/usage failure: actionable message, exit 2, E2E_SESSION_EXIT line printed by main's guard. */
function envFail(message) {
  console.error(`\nENVIRONMENT FAILURE: ${message}`);
  console.log("E2E_SESSION_EXIT=2");
  process.exit(2);
}

/* ------------------------------------------------------------------- http */

async function req(method, url, { headers = {}, body, timeoutMs = 30_000 } = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { status: 0, json: null, text: String(error?.message ?? error) };
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body — the status/text carry the evidence */
  }
  return { status: res.status, json, text };
}

const who = (id, role) => ({ "x-participant-id": id, "x-participant-role": role });
const opsHeaders = () => (process.env.OPS_TOKEN ? { "x-ops-token": process.env.OPS_TOKEN } : {});

function postCommand(edge, command, identity, options = {}) {
  return req("POST", `${edge}/command`, {
    headers: { "content-type": "application/json", ...identity },
    body: JSON.stringify(command),
    ...options,
  });
}

/** One real photo through the capture seam (ADR-0010): bytes in, signed r2:// reference out. */
async function capturePhoto(edge, label) {
  const res = await req("POST", `${edge}/captures`, {
    headers: { "content-type": "image/png" },
    body: Buffer.from(PIXEL_PNG_B64, "base64"),
  });
  check(`${label}: photo captured via POST /captures`, res.status === 200 && typeof res.json?.ref === "string", `HTTP ${res.status}: ${res.text}`);
  return res.json?.ref;
}

/* --------------------------------------------- settlement oracle (test-only) */

const BPS = 10_000;

/**
 * Independent re-derivation of packages/domain/src/settlement.ts for the two
 * modes this script exercises (disputed, aborted). This is an oracle: if it
 * ever drifts from the domain function, the mismatch it reports IS the
 * finding — do not "fix" the oracle to match a bug.
 */
function expectedOutcome(inputs) {
  const goodsTotal = inputs.sellers.reduce((sum, s) => sum + s.amountKobo, 0);
  const completed = inputs.sellers.filter((s) => s.stopCompleted);
  const completedTotal = completed.reduce((sum, s) => sum + s.amountKobo, 0);
  const sellers = inputs.sellers.map((s) => ({ sellerId: s.sellerId, amountKobo: s.stopCompleted ? s.amountKobo : 0 }));

  if (inputs.mode === "aborted") {
    const policy = inputs.abortSplit ?? { disruptionCompensationBps: 2_500, platformFeeBps: 1_000, ambiguousLossCapKobo: 5_000 };
    const disruption = Math.floor((inputs.deliveryPriceKobo * policy.disruptionCompensationBps) / BPS);
    const platformFee = Math.floor((inputs.deliveryPriceKobo * policy.platformFeeBps) / BPS);
    return {
      sellers,
      runnerKobo: disruption,
      platformKobo: platformFee,
      buyerRefundKobo: goodsTotal - completedTotal + inputs.deliveryPriceKobo - disruption - platformFee + inputs.deliveryMarginKobo,
      platformLossKobo: 0,
    };
  }

  // disputed: confirmed exchange points settle; the buyer recovers the
  // residual; the platform retains its delivery margin and absorbs a capped
  // loss only when the evidence is ambiguous (ADR-0007).
  const fraction = inputs.sellers.length === 0 ? 0 : completed.length / inputs.sellers.length;
  const runnerPayout = Math.floor(inputs.deliveryPriceKobo * fraction);
  const buyersPool = goodsTotal - completedTotal + inputs.deliveryPriceKobo - runnerPayout;
  const dispute = inputs.dispute ?? { ambiguous: true };
  const cap = inputs.abortSplit?.ambiguousLossCapKobo ?? 5_000;
  const platformLoss = dispute.ambiguous ? Math.min(dispute.requestedPlatformLossKobo ?? 0, cap) : 0;
  return {
    sellers,
    runnerKobo: runnerPayout,
    platformKobo: inputs.deliveryMarginKobo,
    buyerRefundKobo: buyersPool + platformLoss,
    platformLossKobo: platformLoss,
  };
}

function sameSellers(actual, expected) {
  const norm = (list) => list.map((s) => `${s.sellerId}=${s.amountKobo}`).sort();
  return JSON.stringify(norm(actual)) === JSON.stringify(norm(expected));
}

/** What the captured total is for a settlement: goods + delivery + platform margin (ADR-0008's yardstick). */
function capturedTotalKobo(inputs) {
  return inputs.sellers.reduce((sum, s) => sum + s.amountKobo, 0) + inputs.deliveryPriceKobo + inputs.deliveryMarginKobo;
}

/** Mirrors apps/archive/src/settlement-legs.ts: the ledger identity every settlement must write. */
function expectedLedgerLegs(outcome, ids) {
  const legs = [];
  for (const s of outcome.sellers) {
    if (s.amountKobo > 0) legs.push({ account: "seller_payable", party_id: s.sellerId, debit_kobo: 0, credit_kobo: s.amountKobo });
  }
  if (outcome.runnerKobo > 0) legs.push({ account: "runner_payable", party_id: ids.runnerId, debit_kobo: 0, credit_kobo: outcome.runnerKobo });
  if (outcome.platformKobo > 0) legs.push({ account: "platform_revenue", party_id: null, debit_kobo: 0, credit_kobo: outcome.platformKobo });
  if (outcome.buyerRefundKobo > 0) legs.push({ account: "buyer_refund", party_id: ids.buyerId, debit_kobo: 0, credit_kobo: outcome.buyerRefundKobo });
  if (outcome.platformLossKobo > 0) legs.push({ account: "platform_loss", party_id: null, debit_kobo: outcome.platformLossKobo, credit_kobo: 0 });
  const credited = legs.reduce((sum, l) => sum + l.credit_kobo, 0);
  const debited = legs.reduce((sum, l) => sum + l.debit_kobo, 0);
  const capture = credited - debited;
  if (capture > 0) legs.push({ account: "buyer_capture", party_id: ids.buyerId, debit_kobo: capture, credit_kobo: 0 });
  return legs;
}

/** Mirrors apps/edge/src/do/run/payment-dispatch.ts: sellers (amount>0) in outcome order, then runner, then platform. */
function expectedDispatchLegs(outcome, ids) {
  const legs = [];
  for (const s of outcome.sellers) {
    if (s.amountKobo > 0) legs.push({ account: "seller", party_id: s.sellerId, amount_kobo: s.amountKobo });
  }
  if (outcome.runnerKobo > 0) legs.push({ account: "runner", party_id: ids.runnerId, amount_kobo: outcome.runnerKobo });
  if (outcome.platformKobo > 0) legs.push({ account: "platform", party_id: "platform", amount_kobo: outcome.platformKobo });
  return legs;
}

/* --------------------------------------------------------------- preflight */

async function preflight(edge, paymentsUrl, sql, maskedDb) {
  section("preflight — stack must already be running");
  const health = await req("GET", `${edge}/healthz`, { timeoutMs: 3_000 });
  if (health.status !== 200) {
    envFail(`edge unreachable at ${edge}/healthz — start the stack: npx pnpm@9.15.4 dev:all`);
  }
  console.log(`  • edge ${edge} healthy`);

  const paymentsHealth = await req("GET", `${paymentsUrl}/healthz`, { timeoutMs: 3_000 });
  if (paymentsHealth.status !== 200 || typeof paymentsHealth.json?.dispatcher !== "string") {
    envFail(
      `payments unreachable at ${paymentsUrl}/healthz — start the stack: npx pnpm@9.15.4 dev:all` +
        ` (active dispatcher is read from the worker, not assumed from .dev.vars)`,
    );
  }
  const activeDispatcher = paymentsHealth.json.dispatcher;
  const configuredDispatcher = process.env.PAYMENT_DISPATCHER ?? "stub";
  console.log(
    `  • payments ${paymentsUrl} healthy: dispatcher=${activeDispatcher}` +
      (activeDispatcher === configuredDispatcher
        ? ""
        : ` (configured=${configuredDispatcher} — worker is stale or started with different env; restart the stack)`),
  );

  try {
    await sql`SELECT 1`;
  } catch {
    envFail(`Postgres unreachable at ${maskedDb} — start the stack: npx pnpm@9.15.4 dev:all (it boots the container and applies migrations)`);
  }
  console.log(`  • postgres ${maskedDb} answers`);
  const stores = await req("GET", `${edge}/markets/${encodeURIComponent(MARKET)}/stores`);
  const ids = new Set((stores.json?.stores ?? []).map((s) => s.id));
  const missing = ["store:demo-aminas-fresh", "store:demo-mama-ngozi"].filter((id) => !ids.has(id));
  if (stores.status !== 200 || missing.length > 0) {
    envFail(`demo seed missing in ${MARKET} (${missing.join(", ") || "store list unreadable"}) — start the stack: npx pnpm@9.15.4 dev:all (seed is on by default)`);
  }
  console.log("  • demo seed present (Amina's Fresh Store, Mama Ngozi Provisions)");
}

/**
 * The market-close gate (checkout requires close − now > estTrip + buffer).
 * A market whose closeAt lapsed refuses checkout with 409 market-close-gate;
 * the sanctioned lever (runbook S6b) is an ops config write rolling closeAt
 * forward — fired only when the gate would actually refuse.
 */
async function ensureMarketOpen(edge) {
  const res = await req("GET", `${edge}/markets/${encodeURIComponent(MARKET)}/config`);
  if (res.status !== 200 || !res.json) {
    envFail(`market config unreadable (HTTP ${res.status}) — is the edge up? start the stack: npx pnpm@9.15.4 dev:all`);
  }
  const config = res.json;
  const now = Date.now();
  const neededMs = config.estTripMs + config.bufferMs;
  if (config.closeAt - now > neededMs) {
    console.log(`  • market-close gate open (close ${new Date(config.closeAt).toISOString()}, headroom ${Math.round((config.closeAt - now - neededMs) / 60_000)} min)`);
    return;
  }
  const rolled = { ...config, closeAt: now + MARKET_OPEN_ROLL_MS };
  const write = await req("POST", `${edge}/markets/${encodeURIComponent(MARKET)}/config`, {
    headers: { "content-type": "application/json", ...opsHeaders() },
    body: JSON.stringify(rolled),
  });
  check(
    "ensure-market-open: closeAt rolled forward via the ops config lever",
    write.status === 200 && write.json?.closeAt === rolled.closeAt,
    `HTTP ${write.status}: ${write.text}${write.status === 403 && !process.env.OPS_TOKEN ? " (edge has OPS_TOKEN set — export the same OPS_TOKEN for this script)" : ""}`,
  );
  console.log(`  • ensure-market-open FIRED: closeAt ${new Date(config.closeAt).toISOString()} → ${new Date(rolled.closeAt).toISOString()} (runbook S6b)`);
}

/* ------------------------------------------------------------ wire players */

/** Intent → (optional seller discovery) → offer → accept → checkout. Returns the edge-issued ids. */
async function playToCheckout(label, edge, buyerId, store, delivery, { withDiscovery }) {
  const tag = buyerId.split(":").pop();
  const intentId = `intent-${tag}`;
  const productId = `product-${tag}`;

  const intent = await postCommand(
    edge,
    {
      type: "intent.posted",
      intentId,
      shopItem: store.shopItem,
      quantity: store.quantity,
      unit: store.unit,
      priceBand: store.priceBand,
      note: `${label} e2e rehearsal`,
      market: MARKET,
    },
    who(buyerId, "buyer"),
  );
  check(
    `${label}: intent posted (${intentId})`,
    intent.status === 200 && intent.json?.intent?.id === intentId && intent.json.intent.buyerId === buyerId && intent.json.intent.status === "open",
    `HTTP ${intent.status}: ${intent.text}`,
  );

  if (withDiscovery) {
    // The seller's scoped read (ADR-0021). Headerless on purpose: an identity
    // header is adopted as the BUYER scope and intersected, which would hide
    // the intent — the seller app sends none (apps/mobile/src/api/client.ts).
    const discovery = await req("GET", `${edge}/markets/${encodeURIComponent(MARKET)}/discovery?shopItems=${encodeURIComponent(store.shopItem)}`);
    const found = (discovery.json?.intents ?? []).find((entry) => entry.intent.id === intentId);
    check(
      `${label}: seller scoped discovery surfaces the intent (products inline)`,
      discovery.status === 200 && found !== undefined && Array.isArray(found.products),
      `HTTP ${discovery.status}: ${discovery.text}`,
    );
  }

  const offer = await req("POST", `${edge}/markets/${encodeURIComponent(MARKET)}/offers`, {
    headers: { "content-type": "application/json", ...who(store.sellerId, "seller") },
    body: JSON.stringify({
      productId,
      intentId,
      market: MARKET,
      shopItem: store.shopItem,
      quantity: store.quantity,
      unit: store.unit,
      priceKobo: store.priceKobo,
      sellerName: store.sellerName,
      exchangePoint: store.exchangePoint,
    }),
  });
  check(
    `${label}: seller offer recorded (${productId}, ${store.priceKobo} kobo)`,
    offer.status === 200 && offer.json?.product?.id === productId && offer.json.product.status === "available" && offer.json.product.priceKobo === store.priceKobo,
    `HTTP ${offer.status}: ${offer.text}`,
  );

  const accept = await postCommand(edge, { type: "product.accepted", productId }, who(buyerId, "buyer"));
  const cart = accept.json?.cart;
  check(
    `${label}: offer accepted into the cart (edge-issued cart id)`,
    accept.status === 200 && typeof cart?.id === "string" && cart.status === "open" && cart.products?.length === 1 && cart.products[0].status === "accepted",
    `HTTP ${accept.status}: ${accept.text}`,
  );

  // OSRM is called at checkout; the public demo server can take seconds.
  const checkout = await postCommand(edge, { type: "checkout.requested", cartId: cart.id, delivery }, who(buyerId, "buyer"), { timeoutMs: 90_000 });
  const accepted = checkout.json;
  const gated = checkout.status === 409 && JSON.stringify(accepted).includes("payment");
  check(
    `${label}: checkout accepted at the floor rate (${accepted?.floorRateKobo} kobo)`,
    checkout.status === 200 && accepted?.type === "checkout.accepted" && accepted.cartId === cart.id && typeof accepted.runId === "string" && Number.isInteger(accepted.floorRateKobo),
    `HTTP ${checkout.status}: ${checkout.text}${gated ? " (edge is PAYMENTS_REQUIRED-gated — this script rehearses the unpaid dev posture)" : ""}`,
  );
  return { cartId: cart.id, runId: accepted.runId, floorRateKobo: accepted.floorRateKobo };
}

/**
 * One QR-challenge handoff the ADR-0020 way: open, scan (photoless → the
 * refusal IS the assertion), capture, attach photo (the confirm act).
 */
async function playHandoff(label, edge, runId, handoff) {
  const initiated = await req("POST", `${edge}/runs/${encodeURIComponent(runId)}/handoffs`, {
    headers: { "content-type": "application/json", ...who(RUNNER_ID, "runner") },
    body: JSON.stringify(handoff),
  });
  check(
    `${label}: handoff opened (${handoff.handoffId} @ ${handoff.exchangePointId})`,
    initiated.status === 200 && initiated.json?.type === "handoff.initiated" && initiated.json.handoffId === handoff.handoffId,
    `HTTP ${initiated.status}: ${initiated.text}`,
  );

  const scan = await postCommand(
    edge,
    { type: "handoff.challenge-scanned", handoffId: handoff.handoffId, runId, scannedAt: Date.now() },
    who(RUNNER_ID, "runner"),
  );
  check(
    `${label}: photoless scan refused 409 photo-required (ADR-0020 — the scan alone never confirms)`,
    scan.status === 409 && scan.json?.error === "photo-required",
    `HTTP ${scan.status}: ${scan.text}`,
  );

  const photoRef = await capturePhoto(edge, label);
  const photo = await req("POST", `${edge}/runs/${encodeURIComponent(runId)}/handoffs/${encodeURIComponent(handoff.handoffId)}/photo`, {
    headers: { "content-type": "application/json", ...who(RUNNER_ID, "runner") },
    body: JSON.stringify({ type: "handoff.photo-captured", handoffId: handoff.handoffId, photoCaptureRef: photoRef, capturedAt: Date.now() }),
  });
  const wireHandoff = (photo.json?.run?.handoffs ?? []).find((h) => h.id === handoff.handoffId);
  check(
    `${label}: photo attached — the handoff confirmed (photo IS the confirm act)`,
    photo.status === 200 && wireHandoff?.status === "confirmed" && wireHandoff.photoCaptureRef === photoRef && wireHandoff.autoConfirmed === false,
    `HTTP ${photo.status}: ${photo.text}`,
  );
  return photoRef;
}

/** Ops settle and assert the outcome equals the domain split for the echoed inputs (ADR-0007). */
async function playOpsSettle(label, edge, runId, buyerId, settleRequest) {
  const res = await req("POST", `${edge}/ops/api/runs/${encodeURIComponent(runId)}/settle`, {
    headers: { "content-type": "application/json", ...opsHeaders() },
    body: JSON.stringify(settleRequest),
  });
  const settlement = res.json?.settlement;
  check(
    `${label}: ops settle released (mode=${settleRequest.mode})`,
    res.status === 200 && res.json?.adjusted === true && settlement?.type === "settlement.released" && settlement.mode === settleRequest.mode,
    `HTTP ${res.status}: ${res.text}${res.status === 403 && !process.env.OPS_TOKEN ? " (edge has OPS_TOKEN set — export the same OPS_TOKEN for this script)" : ""}`,
  );

  const inputs = settlement.inputs;
  const expected = expectedOutcome(inputs);
  const outcome = {
    sellers: settlement.sellers,
    runnerKobo: settlement.runnerKobo,
    platformKobo: settlement.platformKobo,
    buyerRefundKobo: settlement.buyerRefundKobo,
    platformLossKobo: settlement.platformLossKobo,
  };
  check(
    `${label}: settlement kobo == domain split for the echoed inputs ${JSON.stringify({ runner: expected.runnerKobo, platform: expected.platformKobo, refund: expected.buyerRefundKobo, loss: expected.platformLossKobo })}`,
    sameSellers(outcome.sellers, expected.sellers) &&
      outcome.runnerKobo === expected.runnerKobo &&
      outcome.platformKobo === expected.platformKobo &&
      outcome.buyerRefundKobo === expected.buyerRefundKobo &&
      outcome.platformLossKobo === expected.platformLossKobo,
    `outcome ${JSON.stringify(outcome)} != expected ${JSON.stringify(expected)}`,
  );

  const capture = capturedTotalKobo(inputs);
  check(
    `${label}: buyer refund strictly less than capture (ADR-0008: ${settlement.buyerRefundKobo} < ${capture})`,
    settlement.buyerRefundKobo > 0 && settlement.buyerRefundKobo < capture,
    `refund ${settlement.buyerRefundKobo} vs capture ${capture}`,
  );

  return { inputs, outcome, buyerId, runnerId: settlement.runnerId };
}

/* ---------------------------------------------------------------- scenarios */

async function playS3(edge, tag) {
  const label = "S3";
  const buyerId = `buyer:e2e-s3-${tag}`;
  const { runId } = await playToCheckout(label, edge, buyerId, S3_STORE, { kind: "plus-code", plusCode: "6FR5+8X Lagos" }, { withDiscovery: true });

  const run = await req("GET", `${edge}/runs/${encodeURIComponent(runId)}`);
  const stop = run.json?.run?.stops?.[0];
  check(`${label}: run live with its seller stop`, run.status === 200 && stop?.exchangePoint === S3_STORE.exchangePoint, `HTTP ${run.status}: ${run.text}`);

  const pickupRef = await playHandoff(label, edge, runId, {
    handoffId: `handoff-e2e-s3-${tag}-pickup`,
    exchangePointId: stop.exchangePoint,
    counterparty: stop.sellerName,
  });
  const afterPickup = await req("GET", `${edge}/runs/${encodeURIComponent(runId)}`);
  check(
    `${label}: pickup confirmed — run delivering, stop completed`,
    afterPickup.json?.run?.status === "delivering" && afterPickup.json.run.stops[0].status === "completed",
    `HTTP ${afterPickup.status}: ${afterPickup.text}`,
  );

  const deliveryLabel = run.json.run.delivery.kind === "plus-code" ? run.json.run.delivery.plusCode : run.json.run.delivery.name;
  const deliveryRef = await playHandoff(label, edge, runId, {
    handoffId: `handoff-e2e-s3-${tag}-delivery`,
    exchangePointId: deliveryLabel,
    counterparty: buyerId,
  });

  const finalDelivery = await req("POST", `${edge}/runs/${encodeURIComponent(runId)}/delivery/final`, {
    headers: { "content-type": "application/json", ...who(RUNNER_ID, "runner") },
    body: "{}",
  });
  check(
    `${label}: final delivery stamped — dispute window armed`,
    finalDelivery.status === 200 && finalDelivery.json?.run?.status === "delivered" && Number.isInteger(finalDelivery.json.run.finalDeliveryAt),
    `HTTP ${finalDelivery.status}: ${finalDelivery.text}`,
  );

  const reason = "e2e S3: short-weight claim at delivery — evidence ambiguous, platform absorbs the capped loss";
  const dispute = await req("POST", `${edge}/runs/${encodeURIComponent(runId)}/dispute`, {
    headers: { "content-type": "application/json", ...who(buyerId, "buyer") },
    body: JSON.stringify({ reason }),
  });
  const refs = dispute.json?.evidenceRefs ?? [];
  check(
    `${label}: buyer dispute recorded — raiser attributed, evidence merged server-side (ADR-0019)`,
    dispute.status === 200 &&
      dispute.json?.disputed === true &&
      dispute.json.raisedByParticipantId === buyerId &&
      refs.includes(pickupRef) &&
      refs.includes(deliveryRef),
    `HTTP ${dispute.status}: ${dispute.text}`,
  );

  const settled = await playOpsSettle(label, edge, runId, buyerId, { mode: "disputed", ambiguous: true, requestedPlatformLossKobo: 5_000, reason });
  return { runId, buyerId, mode: "disputed", reason, photoRefs: [pickupRef, deliveryRef], ...settled };
}

async function playS4(edge, tag) {
  const label = "S4";
  const buyerId = `buyer:e2e-s4-${tag}`;
  const { runId } = await playToCheckout(label, edge, buyerId, S4_STORE, { kind: "muster-point", name: "Balogun Market Partner" }, { withDiscovery: false });

  const run = await req("GET", `${edge}/runs/${encodeURIComponent(runId)}`);
  const stop = run.json?.run?.stops?.[0];
  check(`${label}: run live with its seller stop`, run.status === 200 && stop?.exchangePoint === S4_STORE.exchangePoint, `HTTP ${run.status}: ${run.text}`);

  await playHandoff(label, edge, runId, {
    handoffId: `handoff-e2e-s4-${tag}-pickup`,
    exchangePointId: stop.exchangePoint,
    counterparty: stop.sellerName,
  });

  // The wire's abort path: no runner-facing abort route exists on the RunDO —
  // the abort is expressed through the ops-settle escape hatch with
  // mode=aborted (the console's "aborted — partial settle (ADR-0008)").
  const reason = "e2e S4: runner aborts mid-trip after pickup — partial settle, aborts never refund fully";
  const settled = await playOpsSettle(label, edge, runId, buyerId, { mode: "aborted", reason });
  return { runId, buyerId, mode: "aborted", ...settled };
}

/* ------------------------------------------------------------ db assertions */

const kobo = (value) => Number(value ?? 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollRow(label, query) {
  const deadline = Date.now() + DB_POLL_MS;
  for (;;) {
    const rows = await query();
    if (rows.length > 0) return rows[0];
    if (Date.now() > deadline) {
      check(`${label}: archived to Postgres within ${DB_POLL_MS / 1000}s`, false, "row never appeared — is the archive consumer (:8788) running?");
      return null;
    }
    await sleep(1_000);
  }
}

async function assertDb(label, sql, ctx) {
  section(`${label} — Postgres proof (archive + payments consumers)`);
  const recordId = `${ctx.runId}:settlement`;

  const settlement = await pollRow(label, () => sql`SELECT * FROM settlement_records WHERE run_id = ${ctx.runId}`);
  if (!settlement) return;
  check(
    `${label}: settlement_records row — mode + kobo columns match the released outcome`,
    settlement.id === recordId &&
      settlement.mode === ctx.mode &&
      kobo(settlement.runner_kobo) === ctx.outcome.runnerKobo &&
      kobo(settlement.platform_kobo) === ctx.outcome.platformKobo &&
      kobo(settlement.buyer_refund_kobo) === ctx.outcome.buyerRefundKobo &&
      kobo(settlement.platform_loss_kobo) === ctx.outcome.platformLossKobo,
    `row ${JSON.stringify({ id: settlement.id, mode: settlement.mode })}`,
  );

  const ledger = await sql`SELECT account, party_id, debit_kobo, credit_kobo FROM ledger_entries WHERE settlement_record_id = ${recordId} ORDER BY id`;
  const actualLegs = ledger.map((l) => ({ account: l.account, party_id: l.party_id, debit_kobo: kobo(l.debit_kobo), credit_kobo: kobo(l.credit_kobo) }));
  const expectedLegs = expectedLedgerLegs(ctx.outcome, ctx);
  const multiset = (legs) => legs.map((l) => JSON.stringify(l)).sort();
  check(
    `${label}: ledger legs match the settlement-legs identity (${actualLegs.length} legs)`,
    JSON.stringify(multiset(actualLegs)) === JSON.stringify(multiset(expectedLegs)),
    `actual ${JSON.stringify(actualLegs)} != expected ${JSON.stringify(expectedLegs)}`,
  );
  const debits = actualLegs.reduce((sum, l) => sum + l.debit_kobo, 0);
  const credits = actualLegs.reduce((sum, l) => sum + l.credit_kobo, 0);
  check(`${label}: ledger balances — debits == credits == ${debits}`, debits === credits && debits > 0, `debits ${debits} vs credits ${credits}`);

  const capture = capturedTotalKobo(ctx.inputs);
  check(
    `${label}: ADR-0008 holds in the durable record — buyer_refund_kobo (${kobo(settlement.buyer_refund_kobo)}) < capture (${capture})`,
    kobo(settlement.buyer_refund_kobo) < capture,
    `refund ${kobo(settlement.buyer_refund_kobo)} vs capture ${capture}`,
  );

  const expectedDispatches = expectedDispatchLegs(ctx.outcome, ctx);
  // The consumer persists all rows first, then executes leg by leg — a row
  // present with attempts=0 is mid-flight, not missing. Poll until every leg
  // exists AND has been executed (attempts ≥ 1) before asserting.
  const dispatchDeadline = Date.now() + DB_POLL_MS;
  let dispatches = [];
  for (;;) {
    dispatches = await sql`SELECT idempotency_key, account, party_id, amount_kobo, status, attempts, failure_reason, failure_retryable FROM payment_dispatches WHERE settlement_record_id = ${recordId} ORDER BY id`;
    const allPresent = dispatches.length >= expectedDispatches.length;
    const allExecuted = allPresent && dispatches.every((d) => kobo(d.attempts) >= 1);
    if (allExecuted || Date.now() > dispatchDeadline) break;
    await sleep(1_000);
  }
  const dispatchOk =
    dispatches.length === expectedDispatches.length &&
    expectedDispatches.every((leg, index) => {
      const row = dispatches.find((d) => d.idempotency_key === `settlement:${recordId}:leg:${index}`);
      return row && row.account === leg.account && row.party_id === leg.party_id && kobo(row.amount_kobo) === leg.amount_kobo;
    });
  check(
    `${label}: every settlement leg has exactly one dispatch row (payment_dispatches, per-leg idempotency keys)`,
    dispatchOk,
    `dispatches ${JSON.stringify(dispatches.map((d) => d.idempotency_key))}`,
  );
  const badStatus = dispatches.find((d) => !["pending", "queued", "sent", "completed"].includes(d.status) || kobo(d.attempts) < 1);
  check(
    `${label}: dispatch legs executed cleanly (no failed rows)`,
    dispatchOk && !badStatus,
    badStatus
      ? `status=${badStatus.status} attempts=${kobo(badStatus.attempts)} retryable=${badStatus.failure_retryable} reason=${badStatus.failure_reason ?? "none"} key=${badStatus.idempotency_key}`
      : undefined,
  );

  const refunds = await sql`SELECT count(*)::int AS n FROM payment_refunds WHERE settlement_record_id = ${recordId}`;
  check(
    `${label}: no payment_refunds row — ungated dev posture (no hold; the rail acks payment.refund_no_hold)`,
    refunds[0].n === 0,
    `${refunds[0].n} refund rows`,
  );

  const live = await sql`SELECT status, retired_at FROM live_runs WHERE run_id = ${ctx.runId}`;
  const expectedStatus = ctx.mode === "aborted" ? "aborted" : "closed";
  check(
    `${label}: live_runs index retired as ${expectedStatus}`,
    live.length === 1 && live[0].status === expectedStatus && live[0].retired_at !== null,
    `row ${JSON.stringify(live[0] ?? null)}`,
  );

  if (ctx.mode === "disputed") {
    const disputes = await sql`SELECT * FROM disputes WHERE run_id = ${ctx.runId}`;
    const row = disputes[0];
    // Detail projection keeps to string fields — bigint columns (absorbed_loss_kobo) don't JSON-serialize.
    const rowSummary = row
      ? JSON.stringify({ id: row.id, raised_by: row.raised_by_participant_id, status: row.status, evidence_refs: row.evidence_refs })
      : "null";
    check(
      `${label}: disputes row materialized at run retirement with the merged photo evidence (L2 doctrine)`,
      disputes.length === 1 &&
        row.id === `${ctx.runId}:dispute` &&
        row.raised_by_participant_id === ctx.buyerId &&
        row.reason === ctx.reason &&
        row.status === "open" &&
        ctx.photoRefs.every((ref) => row.evidence_refs.includes(ref)),
      `row ${rowSummary}`,
    );
  }
}

/* --------------------------------------------------------------- reconcile */

async function runReconcile(sql) {
  section("tie-out — infra/reconcile.mjs --json (any FAIL propagates)");
  const child = spawnSync(process.execPath, [RECONCILE_SCRIPT, "--json"], { encoding: "utf8", env: process.env });
  const stdout = child.stdout ?? "";
  const exitLine = stdout.trimEnd().split("\n").pop() ?? "";
  const reportText = stdout.slice(0, stdout.lastIndexOf("RECONCILE_EXIT=")).trim();
  let report = null;
  try {
    report = JSON.parse(reportText);
  } catch {
    check("reconcile produced a parseable --json report", false, `exit ${child.status}; tail: ${stdout.trim().split("\n").slice(-5).join(" | ")} ${child.stderr ?? ""}`);
    return;
  }
  for (const c of report.checks) {
    const counts = Object.entries(c.counts).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`  [${c.status}] ${c.name} — ${counts}`);
    for (const w of c.warnings) {
      console.log(`      WARN ${w.table} ${w.id}: ${w.why}`);
    }
  }
  // WARN budget is 0 unexplained: print the standing dev-posture explanations,
  // verifying claims against the DB rather than blanket-excusing every WARN.
  const refundWarnings = report.checks.find((c) => c.name === "refund-rail")?.warnings.length ?? 0;
  if (refundWarnings > 0) {
    console.log("      · refund-rail WARNs are ungated-dev refunds (PAYMENTS_REQUIRED unset: no hold exists to refund; the rail acks payment.refund_no_hold) — explained dev posture");
  }
  const dispatchWarnings = report.checks.find((c) => c.name === "dispatch-completeness")?.warnings ?? [];
  if (dispatchWarnings.length > 0) {
    const ids = dispatchWarnings.map((w) => w.id);
    const rows = await sql`SELECT id, provider_ref FROM payment_dispatches WHERE id IN ${sql(ids)}`;
    const stubbed = rows.filter((r) => String(r.provider_ref ?? "").startsWith("stub:")).length;
    if (rows.length === ids.length && stubbed === ids.length) {
      console.log("      · dispatch-completeness WARNs verified against payment_dispatches: all carry stub: provider refs — 'sent' is the stub dispatcher's terminal state (nothing external converges) — explained dev posture");
    } else {
      console.log(`      · UNEXPLAINED: ${ids.length - stubbed} of ${ids.length} stuck-dispatch WARNs are not stub rows — flag these in the session log; the WARN budget is 0 unexplained`);
    }
  }
  check("reconcile child exit code 0", child.status === 0, `exit ${child.status}, ${exitLine}`);
  check("reconcile report ok:true (0 FAIL)", report.ok === true, `discrepancies: ${JSON.stringify(report.checks.flatMap((c) => c.discrepancies))}`);
}

/* --------------------------------------------------------------------- main */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("node infra/e2e-session.mjs [--edge URL] — rehearse runbook S3+S4 over the wire, prove in Postgres, tie out with reconcile.");
    return 0;
  }

  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const maskedDb = databaseUrl.replace(/\/\/[^@]*@/, "//***@");
  const sql = postgres(databaseUrl, { max: 2, types: { bigint: postgres.BigInt } });

  try {
    console.log("== market-runs e2e session rehearsal (runbook S3 dispute + S4 abort) ==");
    console.log(`edge: ${opts.edge}   db: ${maskedDb}`);
    const dispatcher = process.env.PAYMENT_DISPATCHER ?? "stub";
    const testModeRaw = String(process.env.FLUTTERWAVE_TEST_MODE ?? "").trim();
    const testMode = testModeRaw !== "" && testModeRaw !== "0" && testModeRaw.toLowerCase() !== "false";
    console.log(
      `config: dispatcher=${dispatcher}${dispatcher === "flutterwave" ? ` (${testMode ? "test mode" : "live mode"})` : ""}` +
        `   checkout=${process.env.PAYMENTS_REQUIRED ? "gated" : "unpaid-dev"}`,
    );

    const paymentsUrl = process.env.PAYMENTS_URL ?? "http://localhost:8790";
    await preflight(opts.edge, paymentsUrl, sql, maskedDb);
    await ensureMarketOpen(opts.edge);

    const tag = Date.now().toString(36);

    section("S3 — dispute at delivery → ops settle (disputed, ambiguous, capped platform loss)");
    let s3 = null;
    try {
      s3 = await playS3(opts.edge, tag);
    } catch (error) {
      check("S3 scenario completed on the wire", false, String(error?.message ?? error));
    }
    if (s3) await assertDb("S3", sql, s3);

    section("S4 — abort mid-run → partial settle (ADR-0008)");
    let s4 = null;
    try {
      s4 = await playS4(opts.edge, tag);
    } catch (error) {
      check("S4 scenario completed on the wire", false, String(error?.message ?? error));
    }
    if (s4) await assertDb("S4", sql, s4);

    await runReconcile(sql);

    console.log("\n== rehearsal summary ==");
    console.log(`  assertions passed: ${passed}`);
    if (failures.length > 0) {
      console.log(`  FAILURES (${failures.length}):`);
      for (const f of failures) console.log(`    - ${f}`);
    } else {
      console.log("  failures: none");
    }
    const code = failures.length === 0 ? 0 : 1;
    console.log(`E2E_SESSION_EXIT=${code}`);
    return code;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const code = await main().catch((error) => {
  console.error(`e2e session failed to run: ${error?.stack ?? error}`);
  console.log("E2E_SESSION_EXIT=2");
  return 2;
});
process.exit(code);
