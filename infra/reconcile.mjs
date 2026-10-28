#!/usr/bin/env node
/**
 * Three-way reconciliation tie-out for pilot test sessions (ADR-0007/0008/0011).
 *
 * Doctrine under test: money is integer kobo; the settlement function is the
 * ONLY money decision; every kobo a buyer's hold collected is either refunded
 * or released into exactly one settlement; every settlement leg is executed by
 * exactly one dispatch row; the double-entry ledger balances per settlement.
 * Any unexplained kobo stops the test — exit 1 on any FAIL.
 *
 * Checks:
 *   1. ledger-balance        settlement_records ↔ ledger_entries (debits == credits == captured total)
 *   2. hold-conservation     payment_holds ↔ refunds + released-to-settlement
 *   3. dispatch-completeness settlement legs ↔ payment_dispatches (per-leg, exact kobo)
 *   4. refund-rail           payment_refunds ↔ holds + settlement buyerRefundKobo
 *   5. settlement-ledger     every settlement has ledger entries; no orphans
 *   6. vendor (optional)     payment_dispatches ↔ Flutterwave transfers (only with FLUTTERWAVE_SECRET_KEY)
 *
 * Usage:
 *   node infra/reconcile.mjs [--json] [--market=NAME] [--pending-minutes=30]
 *                            [--held-hours=24] [--max-attempts=6]
 * Env:
 *   DATABASE_URL           default postgres://postgres:postgres@localhost:54322/market_runs
 *   FLUTTERWAVE_SECRET_KEY enables the vendor check (test keys hit the same host)
 *
 * infra/.dev.vars is loaded when present (existing shell env wins), so the
 * vendor check uses the same key as the workers instead of silently SKIPping.
 *
 * Dependencies: `postgres` only (resolved from apps/payments — a workspace dep).
 */

import { createRequire } from "node:module";
import { loadDevVars } from "./dev-vars.mjs";

loadDevVars();

// infra/ has no package.json; resolve the workspace dep from apps/payments.
const require = createRequire(new URL("../apps/payments/package.json", import.meta.url));
const postgres = require("postgres");

const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:54322/market_runs";
const FLUTTERWAVE_BASE_URL = "https://api.flutterwave.com";
const KOBO_PER_NAIRA = 100;
/** Mirrors apps/payments/src/provider-reference.ts (short provider-facing alias). */
const PROVIDER_REFERENCE_PREFIX = "mr_";
/** Mirrors apps/payments/src/flutterwave/dispatcher.ts (test-mode accelerator). */
const TEST_MODE_SUCCESS_SUFFIX = "_PMCKDU_1";
/** Queue max_retries=5 (infra/wrangler.payments.toml) + the initial attempt. */
const DEFAULT_MAX_ATTEMPTS = 6;

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const opts = {
    json: false,
    market: null,
    pendingMinutes: 30,
    heldHours: 24,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--market=")) opts.market = arg.slice("--market=".length);
    else if (arg.startsWith("--pending-minutes=")) opts.pendingMinutes = intArg(arg, "--pending-minutes");
    else if (arg.startsWith("--held-hours=")) opts.heldHours = intArg(arg, "--held-hours");
    else if (arg.startsWith("--max-attempts=")) opts.maxAttempts = intArg(arg, "--max-attempts");
    else {
      console.error(`unknown argument: ${arg} (see --help)`);
      process.exit(2);
    }
  }
  return opts;
}

function intArg(arg, name) {
  const value = Number.parseInt(arg.slice(name.length + 1), 10);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name} needs a non-negative integer, got: ${arg}`);
    process.exit(2);
  }
  return value;
}

function printHelp() {
  console.log(`node infra/reconcile.mjs [options]

Three-way reconciliation tie-out (settlements ↔ ledger ↔ holds/refunds/dispatches ↔ vendor).

Options:
  --json                 print a machine-readable report (RECONCILE_EXIT line still comes last)
  --market=NAME          scope all checks to one market (runs_archive.market_id / payment_dispatches.market)
  --pending-minutes=N    WARN on pending/sent/queued dispatches older than N minutes (default 30)
  --held-hours=N         WARN on holds still 'held' older than N hours (default 24)
  --max-attempts=N       retryable 'failed' dispatch with attempts >= N is exhausted → FAIL (default 6 = queue max_retries 5 + 1);
                         a non-retryable failure is a FAIL immediately

Exit code: 1 when any check FAILs (any unexplained kobo stops the test); 0 otherwise.
Env: DATABASE_URL (default ${DEFAULT_DATABASE_URL}), FLUTTERWAVE_SECRET_KEY (enables the vendor check).
infra/.dev.vars is loaded when present; existing shell env wins.`);
}

/* ------------------------------------------------------------ small utils */

/** postgres.js returns bigint columns as BigInt (types option below); kobo fits safely in Number here. */
const kobo = (value) => Number(value ?? 0);
const bareReference = (reference) =>
  reference.endsWith(TEST_MODE_SUCCESS_SUFFIX)
    ? reference.slice(0, -TEST_MODE_SUCCESS_SUFFIX.length)
    : reference;
const minutesAgo = (date) => (Date.now() - date.getTime()) / 60_000;
const hoursAgo = (date) => (Date.now() - date.getTime()) / 3_600_000;

function makeCheck(name) {
  return { name, status: "PASS", counts: {}, discrepancies: [], warnings: [] };
}

function fail(check, table, id, amounts, why) {
  check.status = "FAIL";
  check.discrepancies.push({ table, id, amounts, why });
}

function warn(check, table, id, amounts, why) {
  if (check.status === "PASS") check.status = "WARN";
  check.warnings.push({ table, id, amounts, why });
}

/* ------------------------------------------------------------- the checks */

/**
 * The captured total a settlement's ledger must record as the buyer_capture
 * debit (apps/archive/src/settlement-legs.ts): the sum of credited outcome
 * legs. Dispute loss is already deducted from platform revenue, not external
 * funding. Legacy rows with an actual platform_loss debit subtract that
 * external funding instead. NOTE: seller payouts come from the stored OUTCOME
 * (post-settlement kobo), never from goods_total_kobo — the goods total is an
 * input, and aborted/disputed settlements pay sellers less.
 */
function capturedTotalKobo(settlement) {
  const outcome = settlement.outcome ?? {};
  const sellers = (outcome.sellers ?? []).reduce((sum, s) => sum + Number(s.amountKobo ?? 0), 0);
  return (
    sellers + kobo(settlement.runner_kobo) + kobo(settlement.platform_kobo) +
    kobo(settlement.buyer_refund_kobo) - kobo(settlement.external_platform_loss ?? 0)
  );
}

/**
 * Check 1 — ledger balance. Per settlement_record:
 *   sum(debit_kobo) == sum(credit_kobo), and the buyer_capture debit leg equals
 *   the captured total (capturedTotalKobo — the identity settlement-legs.ts
 *   writes: capture is the balancing debit for all credited value).
 */
async function checkLedgerBalance(sql, settlements) {
  const check = makeCheck("ledger-balance");
  if (settlements.length === 0) {
    check.counts = { settlements: 0 };
    return check;
  }
  const ids = settlements.map((s) => s.id);
  const rows = await sql`
    SELECT le.settlement_record_id,
           COUNT(le.id)::int AS legs,
           COALESCE(SUM(le.debit_kobo), 0)::bigint AS debits,
           COALESCE(SUM(le.credit_kobo), 0)::bigint AS credits,
           COALESCE(SUM(le.debit_kobo) FILTER (WHERE le.account = 'buyer_capture'), 0)::bigint AS capture
    FROM ledger_entries le
    WHERE le.settlement_record_id IN ${sql(ids)}
    GROUP BY le.settlement_record_id
  `;
  const bySettlement = new Map(rows.map((r) => [r.settlement_record_id, r]));
  let balanced = 0;
  for (const s of settlements) {
    const agg = bySettlement.get(s.id);
    if (!agg) continue; // zero ledger rows is check 5's FAIL
    const debits = kobo(agg.debits);
    const credits = kobo(agg.credits);
    const capture = kobo(agg.capture);
    const expectedCapture = capturedTotalKobo(s);
    if (debits !== credits) {
      fail(check, "ledger_entries", s.id, { debits, credits },
        "double-entry legs do not net to zero — money appeared or vanished inside the ledger");
    } else if (capture !== expectedCapture) {
      fail(check, "ledger_entries", s.id, { capture, expectedCapture, debits, credits },
        "buyer_capture debit != settlement captured total — the ledger disagrees with the settlement function's kobo");
    } else {
      balanced += 1;
    }
  }
  check.counts = { settlements: settlements.length, balanced };
  return check;
}

/**
 * Check 2 — hold conservation. A hold is the buyer's collected kobo; it is
 * either refunded (refund rail against the hold) or released into the run's
 * settlement. Per hold with a settlement:
 *   amount == (capture − buyerRefund) + effectiveRefunds
 * where capture = capturedTotalKobo(settlement) and effectiveRefunds = refund
 * rows not in 'failed' (pending/processing/completed move or will move;
 * refund-manual is committed to ops and counted too).
 * A 'released' hold must have a settlement_record for its run.
 */
async function checkHoldConservation(sql, opts, settlementsByRun) {
  const check = makeCheck("hold-conservation");
  const marketFilter = opts.market ? sql`WHERE ra.market_id = ${opts.market}` : sql``;
  const holds = await sql`
    SELECT h.id, h.tx_ref, h.run_id, h.amount_kobo, h.status, h.created_at,
           sr.id AS settlement_id
    FROM payment_holds h
    LEFT JOIN runs_archive ra ON ra.id = h.run_id
    LEFT JOIN settlement_records sr ON sr.run_id = h.run_id
    ${marketFilter}
  `;
  const holdIds = holds.map((h) => h.id);
  const refunds = holdIds.length === 0 ? [] : await sql`
    SELECT id, hold_id, settlement_record_id, amount_kobo, status
    FROM payment_refunds
    WHERE hold_id IN ${sql(holdIds)}
  `;
  const refundsByHold = new Map();
  for (const r of refunds) {
    const list = refundsByHold.get(r.hold_id) ?? [];
    list.push(r);
    refundsByHold.set(r.hold_id, list);
  }

  let conserved = 0;
  for (const h of holds) {
    const amount = kobo(h.amount_kobo);
    const holdRefunds = refundsByHold.get(h.id) ?? [];
    const refundTotal = holdRefunds.reduce((sum, r) => sum + kobo(r.amount_kobo), 0);
    const effectiveRefunds = holdRefunds
      .filter((r) => r.status !== "failed")
      .reduce((sum, r) => sum + kobo(r.amount_kobo), 0);

    if (h.status === "failed") {
      warn(check, "payment_holds", h.id, { amount }, "collection failed at checkout — no money should be held; confirm with the provider");
      continue;
    }
    if (h.status === "held") {
      if (h.settlement_id) {
        warn(check, "payment_holds", h.id, { amount, settlement: h.settlement_id },
          "run settled but the hold was never released — the buyer's kobo is still captured with no settlement claim");
      } else if (hoursAgo(h.created_at) > opts.heldHours) {
        warn(check, "payment_holds", h.id, { amount, heldHours: Math.round(hoursAgo(h.created_at)) },
          `held longer than ${opts.heldHours}h with no settlement — stale captured money`);
      } else {
        conserved += 1;
      }
      continue;
    }

    // released / partially-refunded / refunded: a settlement must exist for the run.
    const settlement = h.run_id ? settlementsByRun.get(h.run_id) : undefined;
    if (!h.settlement_id || !settlement) {
      fail(check, "payment_holds", h.id, { amount, status: h.status, runId: h.run_id },
        `a '${h.status}' hold has no settlement_record for its run — released money with no settlement decision (ADR-0007)`);
      continue;
    }
    const capture = capturedTotalKobo(settlement);
    const settlementPortion = capture - kobo(settlement.buyer_refund_kobo);
    const expected = settlementPortion + effectiveRefunds;
    if (amount !== expected) {
      fail(check, "payment_holds", h.id, { amount, expected, capture, effectiveRefunds, status: h.status },
        "held kobo != refunded + released-to-settlement — an unexplained kobo stops the test");
      continue;
    }
    if ((h.status === "refunded" || h.status === "partially-refunded") && refundTotal > amount) {
      fail(check, "payment_holds", h.id, { amount, refundTotal, status: h.status },
        "refund rows exceed the hold — the buyer was refunded more than they paid");
      continue;
    }
    conserved += 1;
  }
  check.counts = { holds: holds.length, conserved };
  return check;
}

/**
 * Check 3 — dispatch completeness. The edge builds legs in settlement order
 * (apps/edge/src/do/run/payment-dispatch.ts): sellers (amount > 0) in outcome
 * order, then runner, then platform; the consumer persists per-leg rows keyed
 * `settlement:<settlementRecordId>:leg:<index>`. Rebuild the expected legs
 * from the stored outcome and require an exact per-leg amount match.
 * States: completed/sent/queued/pending are terminal-or-progressing;
 * 'failed' with failure_retryable=false is a terminal FAIL immediately (the
 * same request cannot succeed); retryable 'failed' with attempts exhausted
 * (queue max_retries 5 + 1) is also a FAIL; retryable failures with attempts
 * remaining, and pending/sent/queued older than the threshold, are WARNs.
 */
async function checkDispatchCompleteness(sql, opts, settlements, runnerByRun) {
  const check = makeCheck("dispatch-completeness");
  const marketFilter = opts.market ? sql`WHERE d.market = ${opts.market}` : sql``;
  const dispatches = await sql`
    SELECT d.id, d.idempotency_key, d.settlement_record_id, d.run_id, d.market,
           d.account, d.party_id, d.amount_kobo, d.status, d.provider_ref,
           d.failure_reason, d.failure_retryable, d.attempts, d.updated_at
    FROM payment_dispatches d
    ${marketFilter}
  `;
  const byKey = new Map(dispatches.map((d) => [d.idempotency_key, d]));
  const settlementIds = new Set(settlements.map((s) => s.id));

  let matchedLegs = 0;
  let expectedLegs = 0;
  for (const s of settlements) {
    const outcome = s.outcome ?? {};
    const legs = [];
    for (const seller of outcome.sellers ?? []) {
      if (seller.amountKobo > 0) legs.push({ account: "seller", partyId: seller.sellerId, amountKobo: seller.amountKobo });
    }
    if (kobo(outcome.runnerKobo) > 0) {
      legs.push({ account: "runner", partyId: runnerByRun.get(s.run_id) ?? "?", amountKobo: kobo(outcome.runnerKobo) });
    }
    if (kobo(outcome.platformKobo) > 0) {
      legs.push({ account: "platform", partyId: "platform", amountKobo: kobo(outcome.platformKobo) });
    }
    for (let index = 0; index < legs.length; index += 1) {
      expectedLegs += 1;
      const leg = legs[index];
      const key = `settlement:${s.id}:leg:${index}`;
      const row = byKey.get(key);
      if (!row) {
        fail(check, "payment_dispatches", key, { expected: leg },
          "settlement leg has no dispatch row — the settlement decided this kobo moves and nothing executed it");
        continue;
      }
      if (kobo(row.amount_kobo) !== leg.amountKobo || row.account !== leg.account || row.party_id !== leg.partyId) {
        fail(check, "payment_dispatches", row.id, {
          expected: leg, actual: { account: row.account, partyId: row.party_id, amountKobo: kobo(row.amount_kobo) },
        }, "dispatch row disagrees with the settlement leg — execution drifted from the money decision");
        continue;
      }
      matchedLegs += 1;
    }
  }

  // Dispatches that no expected leg claims: execution with no settlement
  // authorization (or drifted keys) — never silent.
  const expectedKeys = new Set();
  for (const s of settlements) {
    const outcome = s.outcome ?? {};
    let n = (outcome.sellers ?? []).filter((x) => x.amountKobo > 0).length;
    if (kobo(outcome.runnerKobo) > 0) n += 1;
    if (kobo(outcome.platformKobo) > 0) n += 1;
    for (let i = 0; i < n; i += 1) expectedKeys.add(`settlement:${s.id}:leg:${i}`);
  }
  let stateWarn = 0;
  for (const d of dispatches) {
    if (!settlementIds.has(d.settlement_record_id)) {
      fail(check, "payment_dispatches", d.id, { amountKobo: kobo(d.amount_kobo), settlementRecordId: d.settlement_record_id },
        "dispatch row points at a settlement_record that does not exist — payout execution with no authorizing decision");
      continue;
    }
    if (!expectedKeys.has(d.idempotency_key)) {
      fail(check, "payment_dispatches", d.id, { idempotencyKey: d.idempotency_key, amountKobo: kobo(d.amount_kobo) },
        "dispatch row matches no expected settlement leg — an extra payout leg the settlement never decided");
      continue;
    }
    if (d.status === "failed") {
      if (d.failure_retryable === false) {
        fail(check, "payment_dispatches", d.id, { amountKobo: kobo(d.amount_kobo), attempts: d.attempts, failureReason: d.failure_reason },
          "terminal dispatch failure (not retryable) — retrying the same request cannot succeed; fix the cause and replay from the ops console");
      } else if (d.attempts >= opts.maxAttempts) {
        fail(check, "payment_dispatches", d.id, { amountKobo: kobo(d.amount_kobo), attempts: d.attempts, failureReason: d.failure_reason },
          `failed with attempts exhausted (>= ${opts.maxAttempts}) — this leg's kobo never moved; replay from the ops console or investigate`);
      } else {
        stateWarn += 1;
        warn(check, "payment_dispatches", d.id, { amountKobo: kobo(d.amount_kobo), attempts: d.attempts, failureReason: d.failure_reason },
          "failed but queue retries remain — should converge; if it persists it becomes a FAIL");
      }
    } else if ((d.status === "pending" || d.status === "sent" || d.status === "queued") && minutesAgo(d.updated_at) > opts.pendingMinutes) {
      stateWarn += 1;
      warn(check, "payment_dispatches", d.id, { status: d.status, amountKobo: kobo(d.amount_kobo), ageMinutes: Math.round(minutesAgo(d.updated_at)) },
        `stuck '${d.status}' beyond ${opts.pendingMinutes}m — in-flight money that is not converging`);
    }
  }
  check.counts = { dispatches: dispatches.length, expectedLegs, matchedLegs, stateWarnings: stateWarn };
  return check;
}

/**
 * Check 4 — refund rail. Every payment_refund ties to a real hold and to a
 * settlement whose buyerRefundKobo equals the refund amount (the settlement
 * function decided the kobo; the rail only executes). 'refund-manual' rows are
 * REPORTED (ops must move the money by hand), not counted as discrepancies.
 * A settlement with buyerRefundKobo > 0 and no refund row is a FAIL when the
 * run has a hold, a WARN when it settled with no gated collection (dev).
 */
async function checkRefundRail(sql, opts, settlements, holdIdSet, runHasHold) {
  const check = makeCheck("refund-rail");
  const settlementIds = settlements.map((s) => s.id);
  const refunds = settlementIds.length === 0 ? [] : await sql`
    SELECT r.id, r.hold_id, r.settlement_record_id, r.amount_kobo, r.status, r.attempts, r.failure_reason
    FROM payment_refunds r
    WHERE r.settlement_record_id IN ${sql(settlementIds)}
  `;
  const bySettlement = new Map(refunds.map((r) => [r.settlement_record_id, r]));
  const settlementById = new Map(settlements.map((s) => [s.id, s]));
  const settlementTotals = new Map();
  for (const r of refunds) settlementTotals.set(r.settlement_record_id, (settlementTotals.get(r.settlement_record_id) ?? 0) + kobo(r.amount_kobo));

  let clean = 0;
  for (const r of refunds) {
    const amount = kobo(r.amount_kobo);
    if (!holdIdSet.has(r.hold_id)) {
      fail(check, "payment_refunds", r.id, { amount, holdId: r.hold_id },
        "refund row points at a hold that does not exist — refunding money we never collected");
      continue;
    }
    if (r.status === "refund-manual") {
      warn(check, "payment_refunds", r.id, { amount, holdId: r.hold_id },
        "refund-manual: no API rail for this payment method — ops must refund the buyer by hand (REPORTED, not a discrepancy)");
      continue;
    }
    if (r.status === "failed") {
      warn(check, "payment_refunds", r.id, { amount, attempts: r.attempts, failureReason: r.failure_reason },
        "refund failed and is retrying — the buyer is still waiting on this kobo");
      continue;
    }
    clean += 1;
  }
  for (const [settlementRecordId, amount] of settlementTotals) {
    const s = settlementById.get(settlementRecordId);
    if (!s || kobo(s.buyer_refund_kobo) !== amount) {
      fail(check, "payment_refunds", settlementRecordId, { amount, settlementBuyerRefundKobo: s ? kobo(s.buyer_refund_kobo) : null },
        "refund rows do not sum to settlement buyerRefundKobo — the rail executed a different kobo than the settlement decided");
    }
  }
  for (const s of settlements) {
    const refundKobo = kobo(s.buyer_refund_kobo);
    if (refundKobo <= 0 || bySettlement.has(s.id)) continue;
    if (runHasHold.get(s.run_id)) {
      fail(check, "settlement_records", s.id, { buyerRefundKobo: refundKobo },
        "settlement decided a buyer refund but no refund row exists — the refund rail never executed the decision");
    } else {
      warn(check, "settlement_records", s.id, { buyerRefundKobo: refundKobo },
        "buyerRefundKobo > 0 but the run had no gated hold (dev checkout) — nothing to refund; confirm this was unpaid dev posture");
    }
  }
  check.counts = { refunds: refunds.length, clean };
  return check;
}

/**
 * Check 5 — settlement ↔ ledger coverage. Every settlement_record has at
 * least one ledger entry (ADR-0007: settlement is the only money movement,
 * the ledger is its record), and no ledger entry is orphaned. The FK makes
 * orphans near-impossible; the check proves it.
 */
async function checkSettlementLedger(sql, settlements) {
  const check = makeCheck("settlement-ledger");
  const ids = settlements.map((s) => s.id);
  let covered = 0;
  if (ids.length > 0) {
    const rows = await sql`
      SELECT le.settlement_record_id, COUNT(le.id)::int AS legs
      FROM ledger_entries le
      WHERE le.settlement_record_id IN ${sql(ids)}
      GROUP BY le.settlement_record_id
    `;
    const coveredIds = new Set(rows.map((r) => r.settlement_record_id));
    for (const s of settlements) {
      if (coveredIds.has(s.id)) covered += 1;
      else {
        fail(check, "settlement_records", s.id, { mode: s.mode },
          "settlement has no ledger entries — a money decision with no double-entry record");
      }
    }
  }
  const orphans = await sql`
    SELECT le.id, le.settlement_record_id, le.account, le.debit_kobo, le.credit_kobo
    FROM ledger_entries le
    LEFT JOIN settlement_records sr ON sr.id = le.settlement_record_id
    WHERE sr.id IS NULL
  `;
  for (const o of orphans) {
    fail(check, "ledger_entries", o.id, { settlementRecordId: o.settlement_record_id, account: o.account, debitKobo: kobo(o.debit_kobo), creditKobo: kobo(o.credit_kobo) },
      "orphan ledger entry — a money movement with no settlement behind it (ADR-0007 forbids side channels)");
  }
  check.counts = { settlements: settlements.length, covered, orphanEntries: orphans.length };
  return check;
}

/* ------------------------------------------------------------ vendor check */

/**
 * Check 6 — vendor tie-out (Flutterwave Transfers v3), only with
 * FLUTTERWAVE_SECRET_KEY. Each dispatch row sends its persisted short
 * provider_reference alias as the transfer `reference`; amounts cross the
 * boundary as naira (kobo/100, exact to 2dp). Legacy rows without an alias
 * fall back to the full idempotency_key. In test mode the provider echoes the
 * `_PMCKDU_1` accelerator suffix, so comparison strips it before matching.
 * Local rows executed by the stub dispatcher (`stub:` provider refs) are
 * reported as skipped — they never hit the provider.
 */
async function checkVendor(sql, opts, dispatches, holds, secretKey) {
  const check = makeCheck("vendor");
  if (!secretKey) {
    check.status = "SKIP";
    check.counts = { skipped: "vendor check skipped (no key)" };
    return check;
  }
  const headers = { authorization: `Bearer ${secretKey}` };
  const get = async (path) => {
    const response = await fetch(`${FLUTTERWAVE_BASE_URL}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => null);
    if (!body || body.status !== "success") {
      throw new Error(`flutterwave ${path} → HTTP ${response.status} ${body?.message ?? ""}`.trim());
    }
    return body;
  };

  let transfers;
  let transactions;
  try {
    transfers = [];
    for (let page = 1; page <= 10; page += 1) {
      const body = await get(`/v3/transfers?page=${page}`);
      transfers.push(...(body.data ?? []));
      // Flutterwave v3 currently nests pagination as meta.page_info; keep the
      // older meta.pagination shape as a fallback.
      const totalPages = body.meta?.page_info?.total_pages ?? body.meta?.pagination?.total_pages ?? page;
      if (page >= totalPages) break;
    }
    transactions = [];
    for (let page = 1; page <= 3; page += 1) {
      const body = await get(`/v3/transactions?page=${page}`);
      transactions.push(...(body.data ?? []));
      const totalPages = body.meta?.page_info?.total_pages ?? body.meta?.pagination?.total_pages ?? page;
      if (page >= totalPages) break;
    }
  } catch (error) {
    // An unreachable vendor proves nothing either way — inconclusive, not a FAIL.
    warn(check, "flutterwave", "api", {}, `vendor check inconclusive: ${String(error.message ?? error)}`);
    return check;
  }

  const transferByReference = new Map();
  for (const t of transfers) {
    if (t.reference) transferByReference.set(bareReference(String(t.reference)), t);
  }

  let matched = 0;
  let stubSkipped = 0;
  for (const d of dispatches) {
    if (d.status !== "completed" && d.status !== "sent" && d.status !== "queued") continue;
    const ref = d.provider_ref ?? "";
    if (!ref.startsWith("flw:")) {
      stubSkipped += 1; // stub dispatcher (or pre-dispatch) — no provider row exists by design
      continue;
    }
    const localReference = d.provider_reference ?? d.idempotency_key;
    let transfer = transferByReference.get(localReference);
    if (!transfer) {
      // List endpoints can be eventually consistent or paginated differently
      // from creation. A persisted provider id is the stronger lookup: verify
      // it directly before declaring that the provider never saw the money.
      try {
        const body = await get(`/v3/transfers/${encodeURIComponent(ref.slice(4))}`);
        if (body.data && bareReference(String(body.data.reference ?? "")) === localReference) transfer = body.data;
      } catch (error) {
        warn(check, "payment_dispatches", d.id, { providerRef: ref },
          `direct provider lookup was inconclusive: ${String(error.message ?? error)}`);
        continue;
      }
    }
    if (!transfer) {
      fail(check, "payment_dispatches", d.id, {
        amountKobo: kobo(d.amount_kobo),
        providerReference: d.provider_reference,
        idempotencyKey: d.idempotency_key,
      }, "executed dispatch has no provider transfer with reference == provider_reference (or legacy idempotencyKey) — money marked moved that the provider never saw");
      continue;
    }
    const providerKobo = Math.round(Number(transfer.amount) * KOBO_PER_NAIRA);
    if (providerKobo !== kobo(d.amount_kobo)) {
      fail(check, "payment_dispatches", d.id, { localKobo: kobo(d.amount_kobo), providerKobo, transferId: transfer.id },
        "provider transfer amount != dispatch amount — a different kobo crossed the vendor boundary");
      continue;
    }
    const providerStatus = String(transfer.status ?? "").toUpperCase();
    const providerCompleted = providerStatus === "SUCCESSFUL";
    if ((d.status === "completed") !== providerCompleted) {
      warn(check, "payment_dispatches", d.id, { localStatus: d.status, providerStatus, transferId: transfer.id },
        "local and provider transfer states disagree — run POST /dispatches/sync or check the webhook path");
      continue;
    }
    matched += 1;
  }

  // Provider transfers carrying OUR reference shape with no local row:
  // payout money moved that Postgres never authorized. New rows use the
  // `mr_` alias; legacy rows may still carry the full settlement key.
  const localKeys = new Set(
    dispatches.flatMap((d) => [d.provider_reference, d.idempotency_key]).filter((value) => value !== null),
  );
  let providerOrphans = 0;
  const sharedTestAccount = secretKey.startsWith("FLWSECK_TEST-");
  for (const t of transfers) {
    const reference = bareReference(String(t.reference ?? ""));
    const ours = reference.startsWith(PROVIDER_REFERENCE_PREFIX) || reference.startsWith("settlement:");
    if (!ours) continue; // unrelated account activity is not ours to reconcile
    if (!localKeys.has(reference)) {
      providerOrphans += 1;
      const detail = { reference, providerKobo: Math.round(Number(t.amount) * KOBO_PER_NAIRA) };
      if (sharedTestAccount) {
        // Hermetic rehearsal databases share the provider's test wallet. A
        // transfer from another temporary DB is expected and must not become a
        // false production orphan. Local executed rows still require a match.
        warn(check, "flutterwave:transfers", String(t.id), detail,
          "test-wallet transfer has no row in this rehearsal database (possible prior/temporary test scope)");
      } else {
        fail(check, "flutterwave:transfers", String(t.id), detail,
          "provider transfer with one of our reference shapes has no local dispatch row — money moved without a Postgres record");
      }
    }
  }

  // Collection side (lighter touch): local holds should exist at the provider
  // with the same amount. WARN-level — checkout already verified server-side.
  const txById = new Map(transactions.map((t) => [String(t.id), t]));
  let holdsMatched = 0;
  for (const h of holds) {
    const tx = txById.get(String(h.provider_tx_id));
    if (!tx) {
      warn(check, "payment_holds", h.id, { providerTxId: h.provider_tx_id, amountKobo: kobo(h.amount_kobo) },
        "hold's provider transaction not found in recent transactions — may be older than the fetched pages");
      continue;
    }
    if (Math.round(Number(tx.amount) * KOBO_PER_NAIRA) !== kobo(h.amount_kobo)) {
      warn(check, "payment_holds", h.id, { localKobo: kobo(h.amount_kobo), providerKobo: Math.round(Number(tx.amount) * KOBO_PER_NAIRA) },
        "provider transaction amount != hold amount — collected kobo disagrees with the recorded hold");
      continue;
    }
    holdsMatched += 1;
  }
  check.counts = {
    transfersFetched: transfers.length,
    dispatchesMatched: matched,
    stubSkipped,
    providerOrphans,
    transactionsFetched: transactions.length,
    holdsMatched,
  };
  return check;
}

/* ------------------------------------------------------------------ main */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }

  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const sql = postgres(databaseUrl, { max: 4, types: { bigint: postgres.BigInt } });

  const report = {
    generatedAt: new Date().toISOString(),
    scope: { market: opts.market ?? "all" },
    thresholds: { pendingMinutes: opts.pendingMinutes, heldHours: opts.heldHours, maxAttempts: opts.maxAttempts },
    checks: [],
    ok: true,
  };

  try {
    // Scoped settlement set (the hub every check joins through), with its
    // run's market + runner for leg reconstruction.
    const marketFilter = opts.market ? sql`WHERE ra.market_id = ${opts.market}` : sql``;
    const settlements = await sql`
      SELECT sr.id, sr.run_id, sr.mode, sr.goods_total_kobo, sr.runner_kobo, sr.platform_kobo,
             sr.buyer_refund_kobo, sr.platform_loss_kobo, sr.outcome, ra.market_id, ra.runner_id,
             COALESCE((SELECT SUM(le.debit_kobo) FROM ledger_entries le
               WHERE le.settlement_record_id = sr.id AND le.account = 'platform_loss'), 0)::bigint AS external_platform_loss
      FROM settlement_records sr
      JOIN runs_archive ra ON ra.id = sr.run_id
      ${marketFilter}
      ORDER BY sr.created_at
    `;
    const settlementsByRun = new Map(settlements.map((s) => [s.run_id, s]));
    const runnerByRun = new Map(settlements.map((s) => [s.run_id, s.runner_id]));

    const checks = [];
    checks.push(await checkLedgerBalance(sql, settlements));
    checks.push(await checkHoldConservation(sql, opts, settlementsByRun));
    checks.push(await checkDispatchCompleteness(sql, opts, settlements, runnerByRun));

    // Refund rail needs the hold universe (scope-consistent with check 2).
    const holdRows = await (opts.market
      ? sql`SELECT h.id, h.run_id, h.provider_tx_id, h.amount_kobo FROM payment_holds h JOIN runs_archive ra ON ra.id = h.run_id WHERE ra.market_id = ${opts.market}`
      : sql`SELECT h.id, h.run_id, h.provider_tx_id, h.amount_kobo FROM payment_holds h`);
    const holdIdSet = new Set(holdRows.map((h) => h.id));
    const runHasHold = new Map();
    for (const h of holdRows) if (h.run_id) runHasHold.set(h.run_id, true);
    checks.push(await checkRefundRail(sql, opts, settlements, holdIdSet, runHasHold));

    checks.push(await checkSettlementLedger(sql, settlements));

    const dispatchRows = await (opts.market
      ? sql`SELECT d.id, d.idempotency_key, d.provider_reference, d.settlement_record_id, d.status, d.provider_ref, d.amount_kobo FROM payment_dispatches d WHERE d.market = ${opts.market}`
      : sql`SELECT d.id, d.idempotency_key, d.provider_reference, d.settlement_record_id, d.status, d.provider_ref, d.amount_kobo FROM payment_dispatches d`);
    checks.push(await checkVendor(sql, opts, dispatchRows, holdRows, process.env.FLUTTERWAVE_SECRET_KEY ?? null));

    report.checks = checks;
    report.ok = checks.every((c) => c.status !== "FAIL");
  } finally {
    await sql.end({ timeout: 5 });
  }

  /* ---- output ---- */
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("== market-runs reconciliation ==");
    console.log(`scope: ${report.scope.market === "all" ? "all markets" : `market=${report.scope.market}`}   db: ${databaseUrl.replace(/\/\/[^@]*@/, "//***@")}`);
    console.log(`thresholds: pending>${report.thresholds.pendingMinutes}m, held>${report.thresholds.heldHours}h, maxAttempts=${report.thresholds.maxAttempts}`);
    console.log("");
    for (const check of report.checks) {
      if (check.status === "SKIP") {
        console.log(`[SKIP] ${check.name} — ${check.counts.skipped}`);
        continue;
      }
      const counts = Object.entries(check.counts).map(([k, v]) => `${k}=${v}`).join(" ");
      console.log(`[${check.status}] ${check.name} — ${counts}`);
    }
    const discrepancies = report.checks.flatMap((c) => c.discrepancies.map((d) => ({ check: c.name, ...d })));
    const warnings = report.checks.flatMap((c) => c.warnings.map((w) => ({ check: c.name, ...w })));
    console.log("");
    if (discrepancies.length > 0) {
      console.log(`Discrepancies (${discrepancies.length}) — any one of these stops the test:`);
      for (const d of discrepancies) {
        console.log(`- [${d.check}] ${d.table} ${d.id}: ${JSON.stringify(d.amounts)}`);
        console.log(`    why: ${d.why}`);
      }
    } else {
      console.log("Discrepancies: none.");
    }
    console.log("");
    if (warnings.length > 0) {
      console.log(`Warnings (${warnings.length}) — WARN budget for a green session is 0 unexplained:`);
      for (const w of warnings) {
        console.log(`- [${w.check}] ${w.table} ${w.id}: ${JSON.stringify(w.amounts)}`);
        console.log(`    why: ${w.why}`);
      }
    } else {
      console.log("Warnings: none.");
    }
    console.log("");
  }
  const exitCode = report.ok ? 0 : 1;
  console.log(`RECONCILE_EXIT=${exitCode}`);
  return exitCode;
}

const code = await main().catch((error) => {
  console.error(`reconcile failed to run: ${error?.stack ?? error}`);
  return 2;
});
process.exit(code);
