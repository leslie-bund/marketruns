/**
 * The single-file ops console: no build step, vanilla JS, polls the JSON API
 * (ADR-0014). Visual language mirrors the mobile app (apps/mobile/src/ui):
 * ink/green/lime on paper, weight-driven system typography, white radius-20
 * cards, pills for status. All money is integer kobo rendered as ₦.
 *
 * Layout: a mission-control grid (ADR-0017) — a slim header bar, a compact
 * gate-metrics strip, then a three-column viewport-fitted grid whose panels
 * scroll internally, so everything vital is visible without page scroll.
 * Below ~1100px the grid stacks and the page scrolls as before.
 */

export const OPS_CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Market Runs — Ops Console</title>
<style>
  :root {
    --ink: #1B3028;
    --muted: #738078;
    --green: #1C6B49;
    --lime: #D9F26B;
    --paper: #F5F6F0;
    --white: #FFFFFF;
    --line: #E7EAE2;
    --orange: #E88748;
    --err: #8E4338;
    --pill-bg: #E6F3EA;
    --secondary: #EDF3EE;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font: 14px/21px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .page {
    height: 100vh; padding: 12px; display: flex; flex-direction: column; gap: 10px;
    max-width: 1760px; margin: 0 auto;
  }
  .eyebrow { font-size: 11px; font-weight: 800; letter-spacing: 1.6px; text-transform: uppercase; color: var(--green); }

  /* slim header bar */
  .bar {
    display: flex; align-items: center; gap: 10px; flex: none;
    background: var(--white); border: 1px solid var(--line); border-radius: 20px; padding: 7px 12px;
  }
  .bar .eyebrow { white-space: nowrap; }
  .bar h1 { font-size: 17px; font-weight: 800; letter-spacing: -0.4px; color: var(--ink); margin: 0; white-space: nowrap; }
  .bar .bar-spacer { flex: 1; }
  .bar select { min-height: 32px; border-radius: 13px; }

  /* compact gate-metrics strip */
  .hero-strip { flex: none; display: flex; flex-direction: column; gap: 6px; }
  .hero-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
  .hero-card {
    background: var(--ink); border-radius: 20px; padding: 10px 13px; color: var(--white);
    display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--ink); min-width: 0;
  }
  .hero-card .eyebrow { color: var(--lime); font-size: 10px; letter-spacing: 1.2px; }
  .hero-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .hero-num { font-size: 27px; font-weight: 900; line-height: 1.05; font-variant-numeric: tabular-nums; color: var(--white); }
  .hero-target { font-size: 11px; font-weight: 700; color: rgba(255,255,255,.62); }
  .hero-pill { align-self: flex-start; padding: 2px 8px; font-size: 10px; }
  .hero-pill.pass { background: var(--lime); color: var(--ink); border-color: var(--lime); }
  .hero-pill.pending { background: transparent; color: rgba(255,255,255,.72); border: 1px solid rgba(255,255,255,.28); }
  .muted-line { color: var(--muted); font-size: 11px; font-weight: 700; margin: 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

  /* mission-control grid: panels scroll internally, the page does not */
  .grid {
    flex: 1; min-height: 0; display: grid; gap: 12px;
    grid-template-columns: 290px minmax(0, 1fr) 390px;
  }
  @media (max-width: 1400px) { .grid { grid-template-columns: 260px minmax(0, 1fr) 340px; } }
  .col { display: flex; flex-direction: column; gap: 10px; min-height: 0; min-width: 0; }
  .card {
    background: var(--white); border: 1px solid var(--line); border-radius: 20px;
    padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; min-height: 0;
  }
  .card.grow { flex: 1; }
  .card.settle { flex: 0 1 auto; max-height: 48%; overflow: auto; }
  .card.overview { flex: 0 1 auto; max-height: 46%; }
  .card-body { flex: 1 1 auto; overflow: auto; min-height: 0; }

  /* slim event feed strip */
  .feed-strip {
    flex: none; flex-direction: row; align-items: flex-start; gap: 12px; padding: 8px 14px;
  }
  .feed-strip .eyebrow { color: var(--muted); padding-top: 3px; white-space: nowrap; }
  #feed { flex: 1; max-height: 54px; overflow: auto; min-width: 0; }
  #feed div { padding: 3px 0; border-bottom: 1px dashed var(--line); font-size: 11px; color: var(--muted); }
  #feed div:last-child { border-bottom: 0; }

  /* collapsed dev driver stays a slim bar until opened */
  details.card { flex: none; padding: 0; overflow: hidden; }
  details.card summary { cursor: pointer; padding: 9px 14px; list-style: none; display: flex; align-items: baseline; gap: 10px; }
  details.card summary::-webkit-details-marker { display: none; }
  details.card summary .summary-title { font-size: 13px; font-weight: 700; color: var(--ink); }
  details.card .details-body { padding: 0 14px 12px; display: flex; flex-direction: column; gap: 8px; max-height: 42vh; overflow: auto; }

  /* markets admin lives in a dialog, off the prime grid */
  dialog {
    border: 1px solid var(--line); border-radius: 20px; background: var(--white); color: var(--ink);
    padding: 16px; width: min(760px, 92vw); max-height: 84vh; overflow: auto;
    display: flex; flex-direction: column; gap: 10px;
    font: inherit;
  }
  dialog:not([open]) { display: none; }
  dialog::backdrop { background: rgba(27,48,40,.42); }
  .dialog-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }

  button {
    min-height: 38px; border: 0; border-radius: 14px; background: var(--green); color: var(--white);
    font: 800 13px/1 inherit; font-family: inherit; padding: 0 16px; cursor: pointer;
  }
  button:hover { filter: brightness(1.06); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.secondary { background: var(--secondary); color: var(--ink); }
  button.compact { min-height: 30px; padding: 0 12px; font-size: 12px; }
  input, select {
    min-height: 38px; border: 1px solid var(--line); border-radius: 13px; background: var(--white);
    color: var(--ink); font: 13px/1 inherit; font-family: inherit; padding: 0 12px;
  }
  input:focus, select:focus { outline: 2px solid var(--green); outline-offset: -1px; }
  input[type="checkbox"] { min-height: 0; width: 16px; height: 16px; accent-color: var(--green); padding: 0; }
  label.field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; font-weight: 700; color: var(--muted); }
  .pill {
    display: inline-flex; align-items: center; border-radius: 99px; padding: 4px 10px;
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px;
    background: var(--paper); color: var(--muted); border: 1px solid var(--line); white-space: nowrap;
  }
  .pill.active { background: var(--pill-bg); color: var(--green); border-color: var(--pill-bg); }
  .pill.warn { background: rgba(232,135,72,.14); color: #A8501A; border-color: rgba(232,135,72,.3); }
  .pill.bad { background: rgba(142,67,56,.1); color: var(--err); border-color: rgba(142,67,56,.24); }
  .pill.lime { background: rgba(217,242,107,.32); color: var(--green); border-color: rgba(217,242,107,.6); }
  button.pill { min-height: 0; cursor: pointer; }
  button.pill.tab { background: var(--paper); color: var(--muted); }
  button.pill.tab.on { background: var(--pill-bg); color: var(--green); border-color: var(--pill-bg); }
  .kv { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 2px 0; }
  .kv .k { font-size: 12px; font-weight: 700; color: var(--muted); }
  .kv .v { font-weight: 700; color: var(--ink); text-align: right; }
  .money { font-weight: 700; color: var(--green); font-variant-numeric: tabular-nums; }
  .row-line { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .row-line:last-child { border-bottom: 0; }
  .row-line.clickable { cursor: pointer; margin: 0 -8px; padding: 7px 8px; border-radius: 12px; }
  .row-line.clickable:hover { background: var(--paper); }
  .row-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
  .row-sub { font-size: 12px; color: var(--muted); }
  .title-id { font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
  .helper { font-size: 12px; color: var(--muted); margin: 0; }
  .empty { color: var(--muted); }
  .empty b { color: var(--ink); font-weight: 700; display: block; margin-bottom: 2px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { border: 1px solid var(--line); background: var(--paper); border-radius: 99px; padding: 3px 9px; font-size: 11px; color: var(--muted); }
  pre {
    margin: 0; background: var(--paper); border: 1px solid var(--line); border-radius: 13px;
    padding: 10px; overflow: auto; max-height: 120px; font-size: 11px; color: var(--ink);
  }
  .tabs { display: flex; gap: 6px; flex-wrap: wrap; }
  .pager { display: flex; align-items: center; gap: 8px; justify-content: flex-end; padding-top: 6px; }
  .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
  .form-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .error-box { background: rgba(142,67,56,.08); border: 1px solid rgba(142,67,56,.24); color: var(--err); border-radius: 13px; padding: 8px 12px; font-size: 12px; font-weight: 700; }
  .info-box { background: rgba(232,135,72,.12); border: 1px solid rgba(232,135,72,.3); color: #A8501A; border-radius: 13px; padding: 8px 12px; font-size: 12px; font-weight: 700; }
  a { color: var(--green); font-weight: 700; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .check-row { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; color: var(--muted); min-height: 38px; }
  .id-chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .id-chips .pill { text-transform: none; letter-spacing: 0; }

  /* vocabulary moderation: pills grouped by store, click-to-rename, × to remove */
  .vocab-store { padding: 7px 0; border-bottom: 1px solid var(--line); }
  .vocab-store:last-child { border-bottom: 0; }
  .vocab-store .chips { margin-top: 5px; }
  .pill.item { text-transform: none; letter-spacing: 0; }
  .pill.item [data-action="vocab-edit"] { cursor: pointer; }
  input.vocab-edit { min-height: 30px; font-size: 12px; padding: 0 10px; border-radius: 99px; min-width: 140px; }

  /* buyer picker: per-buyer carts are addressed server-side via ?buyerId= */
  .buyer-row { display: flex; align-items: center; gap: 6px; }
  .buyer-row input { flex: 1; min-width: 0; min-height: 30px; font-size: 12px; padding: 0 10px; }
  .buyer-row .pill { text-transform: none; letter-spacing: 0; }
  button.pill-x { min-height: 0; padding: 0 0 0 6px; background: transparent; color: inherit; border-radius: 0; font-size: 13px; line-height: 1; }

  /* narrow fallback: stack the grid, page scrolls */
  @media (max-width: 1099px) {
    .page { height: auto; }
    .grid { grid-template-columns: 1fr; }
    .card.settle { max-height: none; overflow: visible; }
    .card-body { overflow: visible; }
    .hero-grid { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
  }
</style>
</head>
<body>
<div class="page">

  <header class="bar">
    <span class="eyebrow">Market Runs — Ops</span>
    <h1>Oversight</h1>
    <span id="gatePill" class="pill">gate —</span>
    <span class="bar-spacer"></span>
    <select id="marketSel" aria-label="Market"></select>
    <span id="operatorPill" class="pill active">operator</span>
    <button type="button" class="secondary compact" id="marketsOpen">Manage</button>
    <button type="button" class="secondary compact" id="signOut">Sign out</button>
  </header>

  <section class="hero-strip">
    <div class="hero-grid" id="heroGrid"></div>
    <div class="muted-line" id="heroMeta">Expansion gate — ADR-0013 · loading…</div>
  </section>

  <main class="grid">
    <div class="col">
      <div class="card overview">
        <div class="eyebrow">Market overview</div>
        <div class="buyer-row">
          <input id="buyerInput" placeholder="buyer id — e.g. buyer:demo" aria-label="Buyer id">
          <button type="button" class="secondary compact" id="buyerView">View</button>
          <span id="buyerPill" class="pill lime" hidden><span id="buyerPillText"></span><button type="button" class="pill-x" id="buyerClear" aria-label="Clear buyer">×</button></span>
        </div>
        <div id="overviewBody" class="empty card-body">Loading…</div>
      </div>
      <div class="card grow">
        <div class="eyebrow">Runs</div>
        <div id="runsBody" class="empty card-body">Loading…</div>
      </div>
    </div>
    <div class="col">
      <div class="card grow">
        <div class="eyebrow">Run detail</div>
        <div id="runBody" class="empty card-body"><b>No run selected.</b>Pick a run from the list, or drive the demo flow below.</div>
      </div>
      <div class="card settle">
        <div class="eyebrow">Ops settle — settlement function only (ADR-0007)</div>
        <div class="kv"><span class="k">Target run</span><span class="v title-id" id="settleTarget">—</span></div>
        <div class="kv" id="settleAwaiting" hidden><span class="k">Handoffs</span><span class="v"><span class="pill warn">awaiting photo evidence</span> <span class="row-sub">a photoless handoff is past its auto-confirm deadline</span></span></div>
        <div class="kv" id="settleDisputed" hidden><span class="k">Dispute</span><span class="v"><span class="pill warn">disputed</span> <span class="row-sub" id="settleDisputeReason"></span></span></div>
        <div class="form-grid">
          <label class="field">Mode
            <select id="settleMode">
              <option value="completed">completed</option>
              <option value="aborted">aborted — partial settle (ADR-0008)</option>
              <option value="disputed">disputed — ambiguous evidence, capped loss</option>
            </select>
          </label>
          <label class="field">Reason (audit context)
            <input id="settleReason" placeholder="why ops is closing this run">
          </label>
          <label class="check-row"><input type="checkbox" id="settleAmbiguous"> evidence ambiguous</label>
          <label class="field" id="settleLossField" hidden>Platform loss to absorb (₦, capped)
            <input id="settleLoss" inputmode="decimal" placeholder="0">
          </label>
        </div>
        <div class="form-actions">
          <button id="settleGo" type="button">Release settlement</button>
        </div>
        <pre id="settleResult">—</pre>
        <p class="helper">Every kobo flows through the settlement function: the mode and dispute evidence become the SettlementInput and the function computes each leg — no side channels. Aborts never refund fully; runner and platform settle partially (ADR-0008).</p>
      </div>
    </div>
    <div class="col">
      <div class="card grow">
        <div class="eyebrow">Oversight</div>
        <div class="tabs" id="oversightTabs"></div>
        <div id="tabBody" class="empty card-body">Loading…</div>
      </div>
    </div>
  </main>

  <section class="card feed-strip">
    <span class="eyebrow">Event feed</span>
    <div id="feed"></div>
  </section>

  <details class="card">
    <summary>
      <span class="eyebrow" style="color:var(--muted)">Dev only</span>
      <span class="summary-title">Dev demo driver</span>
      <span class="helper">Deterministic demo ids per step; each step calls the public edge API. No token needed.</span>
    </summary>
    <div class="details-body">
      <div class="eyebrow">Buyer / seller wire</div>
      <div class="form-actions">
        <button type="button" class="secondary compact" id="drvIntent">1 · Buyer posts intent</button>
        <button type="button" class="secondary compact" id="drvOffer">2 · Seller offers product</button>
        <button type="button" class="secondary compact" id="drvNegotiate">3 · Buyer negotiates −₦500</button>
        <button type="button" class="secondary compact" id="drvAccept">4 · Buyer accepts</button>
        <button type="button" class="secondary compact" id="drvCheckout">5 · Buyer checks out</button>
      </div>
      <div class="id-chips">
        <span class="pill">intent: <b id="intentId">—</b></span>
        <span class="pill">product: <b id="productId">—</b></span>
        <span class="pill">cart: <b id="cartId">—</b></span>
        <span class="pill">run: <b id="runId">—</b></span>
      </div>
      <div class="eyebrow">Runner wire</div>
      <div class="form-actions">
        <button type="button" class="secondary compact" id="drvHandoff">Initiate handoff</button>
        <button type="button" class="secondary compact" id="drvPhoto">Attach photo evidence</button>
        <button type="button" class="secondary compact" id="drvScan">Scan QR challenge</button>
        <button type="button" class="secondary compact" id="drvLocation">Location tick</button>
        <button type="button" class="secondary compact" id="drvFinal">Final delivery</button>
      </div>
      <div id="driverError" class="error-box" hidden></div>
      <div id="driverInfo" class="info-box" hidden></div>
    </div>
  </details>

  <dialog id="marketsDialog">
    <div class="dialog-head">
      <span class="eyebrow">Markets admin</span>
      <button type="button" class="secondary compact" id="marketsClose">Close</button>
    </div>
    <div id="marketsBody" class="empty">Loading…</div>
    <div class="form-actions">
      <button type="button" class="secondary" data-action="new-market">New market</button>
    </div>
    <div id="marketFormWrap" hidden></div>
    <div id="vocabWrap" hidden>
      <div class="dialog-head">
        <span class="eyebrow" id="vocabTitle">Vocabulary</span>
        <button type="button" class="secondary compact" id="vocabRefresh">Refresh</button>
      </div>
      <p class="helper">The vocabulary is the union of every store's shop items (ADR-0006 — grown per market, curated here). Remove drops an item from every store; rename rewrites it in place — the normalization lever. A store left with no items stays registered; it just stops matching intents.</p>
      <div id="vocabError" class="error-box" hidden></div>
      <div id="vocabBody" class="empty">Loading…</div>
    </div>
  </dialog>

  <details class="card" id="pilotPanel">
    <summary><span class="eyebrow">Production pilot</span><span class="summary-title">Live instances & management</span><span class="helper">Explicit heartbeats only — no Durable Object namespace listing</span></summary>
    <div class="details-body">
      <div class="dialog-head"><span class="eyebrow">Live DO instances</span><button class="secondary compact" id="telemetryRefresh" type="button">Refresh</button></div>
      <div id="telemetryBody" class="empty">Open to load explicit instance heartbeats.</div>
      <hr>
      <div class="eyebrow">Stores & shop items</div>
      <div class="form-grid"><input id="storeMarket" placeholder="market"><input id="storeSeller" placeholder="seller participant id"><input id="storeName" placeholder="store name"><input id="storePoint" placeholder="exchange point"><button id="storeCreate" type="button">Create store</button></div>
      <div id="storesBody" class="empty">—</div>
      <hr>
      <div class="eyebrow">Runner pools</div>
      <div class="form-grid"><input id="poolMarket" placeholder="market"><input id="poolName" placeholder="pool name"><button id="poolCreate" type="button">Create pool</button><input id="memberRunner" placeholder="runner participant id"></div>
      <div id="poolsBody" class="empty">—</div>
      <hr>
      <div class="eyebrow">Participant involvements — read only</div>
      <div class="form-actions"><input id="participantLookup" placeholder="participant id"><button id="participantGo" type="button" class="secondary">Look up</button></div>
      <pre id="participantBody">—</pre>
    </div>
  </details>

</div>
<script>
"use strict";

/* ---------- state ---------- */
var S = { market: null, intentId: null, productId: null, cartId: null, runId: null, seq: 0, lastHandoffId: null };
var SEL = {
  runId: null, run: null, runDispute: null, overview: null, health: null, runs: null, markets: [],
  buyer: null,
  tab: "disputes", tabData: {}, pages: { disputes: 0, settlements: 0, ledger: 0, payments: 0 }
};
var PAGE_SIZE = 20;
var MARKET_EDIT = null; /* { id: string|null, config: object|null } while the inline form is open */
/* Monotonic request stamps: a slow response from before a user action
   (market switch, run pick, tab switch) must never overwrite newer state. */
var REQ = { overview: 0, hero: 0, runs: 0, runDetail: 0, tab: 0 };

function $(id) { return document.getElementById(id); }

/* Same-origin Better Auth session cookies; no credentials in URLs or storage. */
api("/ops/api/session").then(function (data) {
  if (data && data.operator) $("operatorPill").textContent = data.operator.name + " · " + data.operator.role;
}).catch(function () { location = "/ops/login"; });
function api(path, options) {
  options = options || {};
  var headers = { "accept": "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return fetch(path, {
    method: options.method || "GET",
    headers: headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  }).then(function (r) {
    if (r.status === 401) { location = "/ops/login"; throw new Error("session expired"); }
    return r.text().then(function (text) {
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
      if (!r.ok) {
        var err = new Error((data && data.message) || ("HTTP " + r.status));
        err.status = r.status;
        err.code = data && data.error;
        err.issues = data && data.issues;
        err.archiveDown = r.status === 503 && !!data && data.error === "archive-unavailable";
        throw err;
      }
      return data;
    });
  });
}

/* Demo-driver calls hit the public edge API — no token. */
function call(method, url, body) {
  return fetch(url, { method: method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}
function command(body) { return call("POST", "/command", body); }

/* ---------- formatters ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}
function money(kobo) {
  if (kobo === null || kobo === undefined || isNaN(kobo)) return "—";
  return "₦" + (kobo / 100).toLocaleString("en-NG");
}
function timeAgo(ts) {
  if (!ts) return "—";
  var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + "s ago";
  var m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  return Math.floor(m / 60) + "h ago";
}
function countdown(ms) {
  var s = Math.max(0, Math.round(ms / 1000));
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  if (s >= 3600) return Math.floor(s / 3600) + ":" + pad(Math.floor((s % 3600) / 60)) + ":" + pad(s % 60);
  return Math.floor(s / 60) + ":" + pad(s % 60);
}
function duration(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) return "—";
  var s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  return Math.round(s / 60) + " min";
}
function bps(b) {
  if (b === null || b === undefined || isNaN(b)) return "—";
  return (b / 100).toFixed(1) + "%";
}
function dateTime(ts) { return ts ? new Date(ts).toLocaleString("en-NG") : "—"; }
function shortId(id) {
  if (!id) return "—";
  return id.length <= 20 ? id : "…" + id.slice(-18);
}
function unwrapRun(x) {
  if (!x) return null;
  if (x.run && x.run.id) return x.run;
  if (x.id) return x;
  return null;
}
function unwrapCart(x) {
  if (!x) return null;
  if (x.cart && x.cart.id) return x.cart;
  if (x.id) return x;
  return null;
}

/* ---------- status pills ---------- */
/* Payments lifecycle: sent/queued are in-flight (orange), completed is
   settled (green), failed is red-ish #8E4338 (the .pill.bad color). */
var GREEN_STATUSES = { completed: 1, closed: 1, confirmed: 1, delivered: 1, resolved: 1 };
var BAD_STATUSES = { aborted: 1, retired: 1, expired: 1, error: 1, failed: 1 };
var WARN_STATUSES = { disputed: 1, open: 1, ambiguous: 1, sent: 1, queued: 1 };
function statusPill(status) {
  var cls = "pill";
  if (GREEN_STATUSES[status]) cls += " active";
  else if (BAD_STATUSES[status]) cls += " bad";
  else if (WARN_STATUSES[status]) cls += " warn";
  return '<span class="' + cls + '">' + esc(status) + "</span>";
}
function emptyState(title, helper) {
  return '<div class="empty"><b>' + esc(title) + "</b>" + esc(helper) + "</div>";
}
function archiveDown(err) { return !!err && err.archiveDown; }
function archiveEmpty() {
  return emptyState("Archive unavailable", "The archive service is not configured or unreachable — live run views above still work.");
}
function paymentsDown(err) { return !!err && err.status === 503 && err.code === "payments-unavailable"; }
function paymentsEmpty() {
  return emptyState("Payments unavailable", "The payments service is not configured or unreachable — settlement legs still queue for dispatch.");
}

/* ---------- feed ---------- */
function feed(msg) {
  var box = $("feed");
  var line = document.createElement("div");
  line.textContent = new Date().toLocaleTimeString() + "  " + msg;
  box.prepend(line);
  while (box.children.length > 40) box.removeChild(box.lastChild);
}
function fail(where, response) {
  return response.text().then(function (body) {
    $("driverInfo").hidden = true;
    var box = $("driverError");
    box.hidden = false;
    box.textContent = where + " → HTTP " + response.status + ": " + body;
    feed(where + " failed (HTTP " + response.status + ")");
  });
}
/* Informational counterpart to fail(): expected refusals (e.g. photo-required)
   are states, not errors. */
function driverInfo(msg) {
  $("driverError").hidden = true;
  var box = $("driverInfo");
  box.hidden = false;
  box.textContent = msg;
}

/* ---------- market selector + markets dialog ---------- */
function market() { return S.market || "Balogun"; }
function loadMarkets() {
  return api("/ops/api/markets").then(function (data) {
    SEL.markets = (data && data.markets) || [];
    if (!S.market) {
      var ids = SEL.markets.map(function (m) { return m.id; });
      S.market = ids.indexOf("Balogun") >= 0 ? "Balogun" : (ids[0] || "Balogun");
    }
    renderMarketSelector();
    renderMarkets();
  }).catch(function (err) {
    if (err.status !== 403) {
      $("marketsBody").innerHTML = emptyState("Could not load markets", err.message);
      renderMarketSelector();
    }
  });
}
function renderMarketSelector() {
  var sel = $("marketSel");
  var ids = SEL.markets.map(function (m) { return m.id; });
  if (ids.indexOf(market()) < 0) ids.push(market());
  sel.innerHTML = ids.map(function (id) {
    return '<option value="' + esc(id) + '"' + (id === market() ? " selected" : "") + ">" + esc(id) + "</option>";
  }).join("");
}
function renderMarkets() {
  var el = $("marketsBody");
  if (!SEL.markets.length) { el.innerHTML = emptyState("No zones yet", "Create the first market zone below."); return; }
  var html = "";
  SEL.markets.forEach(function (m) {
    var cfg = m.config;
    var right = '<button type="button" class="secondary compact" data-action="vocab-market" data-id="' + esc(m.id) + '">Vocabulary</button>' +
      '<button type="button" class="secondary compact" data-action="edit-market" data-id="' + esc(m.id) + '">Edit</button>';
    if (!cfg) {
      html += '<div class="row-line"><div class="row-main"><span class="title-id">' + esc(m.id) + '</span></div>' +
        '<div class="row-main"><span class="row-sub">config unreadable</span>' + right + "</div></div>";
      return;
    }
    html += '<div class="row-line"><div class="row-main"><span class="title-id">' + esc(m.id) + "</span>" +
      '<span class="row-sub">closes ' + esc(dateTime(cfg.closeAt)) + "</span>" +
      '<span class="row-sub">est run ' + esc(duration(cfg.estTripMs)) + " · buffer " + esc(duration(cfg.bufferMs)) + "</span>" +
      '<span class="row-sub">floor <span class="money">' + esc(money(cfg.floorRate.baseKobo)) + "</span></span>" +
      "</div>" + right + "</div>";
  });
  el.innerHTML = html;
}

var NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
function toLocalInput(ts) {
  var d = new Date(ts);
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
}
function nairaToKobo(v) {
  var n = Number(String(v).replace(/,/g, ""));
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}
function openMarketForm(id) {
  var entry = id ? SEL.markets.filter(function (m) { return m.id === id; })[0] : null;
  MARKET_EDIT = { id: entry ? entry.id : null, config: entry ? entry.config : null };
  renderMarketForm();
}
function closeMarketForm() { MARKET_EDIT = null; $("marketFormWrap").hidden = true; $("marketFormWrap").innerHTML = ""; }
function renderMarketForm() {
  var wrap = $("marketFormWrap");
  var creating = !MARKET_EDIT.id;
  var now = Date.now();
  var c = MARKET_EDIT.config || {
    closeAt: now + 8 * 3600 * 1000, estTripMs: 20 * 60000, bufferMs: 5 * 60000,
    floorRate: { distanceMeters: 3000, estimatedDurationMs: 20 * 60000, baseKobo: 100000, perKilometerKobo: 20000, perMinuteKobo: 500 },
    settlement: { goodsCommissionBps: 1000, deliveryMarginKobo: 10000 }
  };
  function koboToNaira(k) { return (k / 100).toString(); }
  wrap.innerHTML =
    '<div class="eyebrow">' + (creating ? "New market" : "Edit — " + esc(MARKET_EDIT.id)) + "</div>" +
    '<div class="form-grid">' +
    (creating ? '<label class="field">Zone name<input id="mktName" maxlength="64" placeholder="Balogun"></label>' : "") +
    '<label class="field">Closes at<input id="mktClose" type="datetime-local" value="' + esc(toLocalInput(c.closeAt)) + '"></label>' +
    '<label class="field">Est run (min)<input id="mktEst" inputmode="numeric" value="' + esc(Math.round(c.estTripMs / 60000)) + '"></label>' +
    '<label class="field">Buffer (min)<input id="mktBuffer" inputmode="numeric" value="' + esc(Math.round(c.bufferMs / 60000)) + '"></label>' +
    '<label class="field">Floor distance (m)<input id="mktDist" inputmode="numeric" value="' + esc(c.floorRate.distanceMeters) + '"></label>' +
    '<label class="field">Floor duration (min)<input id="mktDur" inputmode="numeric" value="' + esc(Math.round(c.floorRate.estimatedDurationMs / 60000)) + '"></label>' +
    '<label class="field">Floor base (₦)<input id="mktBase" inputmode="decimal" value="' + esc(koboToNaira(c.floorRate.baseKobo)) + '"></label>' +
    '<label class="field">Per km (₦)<input id="mktPerKm" inputmode="decimal" value="' + esc(koboToNaira(c.floorRate.perKilometerKobo)) + '"></label>' +
    '<label class="field">Per min (₦)<input id="mktPerMin" inputmode="decimal" value="' + esc(koboToNaira(c.floorRate.perMinuteKobo)) + '"></label>' +
    '<label class="field">Seller goods commission deduction (%)<input id="mktCommission" inputmode="decimal" value="' + esc((c.settlement.goodsCommissionBps / 100).toString()) + '"></label>' +
    '<label class="field">Runner delivery margin deduction (₦)<input id="mktMargin" inputmode="decimal" value="' + esc(koboToNaira(c.settlement.deliveryMarginKobo)) + '"></label>' +
    "</div>" +
    '<p class="helper">Both are deducted from participant proceeds at settlement, never added to the buyer\'s checkout bill. Changes apply only to new runs; existing runs keep their seeded configuration.</p>' +
    '<div id="marketFormError" class="error-box" hidden></div>' +
    '<div class="form-actions">' +
    '<button type="button" id="marketFormSave">' + (creating ? "Create market" : "Save config") + "</button>" +
    '<button type="button" class="secondary" id="marketFormCancel">Cancel</button>' +
    "</div>" +
    (creating ? "" : '<p class="helper">Only timer and coefficient values are editable here — geography (exchange and muster points) is preserved untouched.</p>');
  wrap.hidden = false;
  $("marketFormSave").addEventListener("click", submitMarketForm);
  $("marketFormCancel").addEventListener("click", closeMarketForm);
}
function marketFormError(msg) {
  var box = $("marketFormError");
  box.hidden = false;
  box.textContent = msg;
}
function minutesField(id) {
  var n = Number($(id).value);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 60000);
}
function submitMarketForm() {
  var creating = !MARKET_EDIT.id;
  var name = creating ? $("mktName").value.trim() : MARKET_EDIT.id;
  if (!NAME_RE.test(name)) {
    return marketFormError("Zone names are 1–64 chars: letters, digits, spaces, '.', '_' or '-', starting with a letter or digit.");
  }
  var closeAt = new Date($("mktClose").value).getTime();
  var estTripMs = minutesField("mktEst");
  var bufferMs = minutesField("mktBuffer");
  var dist = Number($("mktDist").value);
  var durMs = minutesField("mktDur");
  var base = nairaToKobo($("mktBase").value);
  var perKm = nairaToKobo($("mktPerKm").value);
  var perMin = nairaToKobo($("mktPerMin").value);
  var commissionPct = Number($("mktCommission").value);
  var margin = nairaToKobo($("mktMargin").value);
  if (!isFinite(closeAt) || estTripMs === null || bufferMs === null || !isFinite(dist) || dist < 0 ||
      durMs === null || base === null || perKm === null || perMin === null ||
      !isFinite(commissionPct) || commissionPct < 0 || commissionPct > 100 || margin === null) {
    return marketFormError("Every field needs a valid non-negative number; commission is 0–100%.");
  }
  var body = {
    closeAt: Math.round(closeAt),
    estTripMs: estTripMs,
    bufferMs: bufferMs,
    floorRate: { distanceMeters: dist, estimatedDurationMs: durMs, baseKobo: base, perKilometerKobo: perKm, perMinuteKobo: perMin },
    settlement: { goodsCommissionBps: Math.round(commissionPct * 100), deliveryMarginKobo: margin }
  };
  if (!creating && MARKET_EDIT.config && MARKET_EDIT.config.geo) body.geo = MARKET_EDIT.config.geo;
  if (creating) body.name = name;
  var path = creating ? "/ops/api/markets" : "/ops/api/markets/" + encodeURIComponent(name) + "/config";
  api(path, { method: "POST", body: body }).then(function () {
    feed((creating ? "market created: " : "market config saved: ") + name);
    closeMarketForm();
    return loadMarkets();
  }).then(function () { refreshLive(); }).catch(function (err) {
    var detail = "";
    if (err.issues && err.issues.length) {
      var issue = err.issues[0];
      detail = " (" + (issue.path && issue.path.length ? issue.path.join(".") + ": " : "") + issue.message + ")";
    }
    marketFormError("HTTP " + (err.status || "?") + " — " + err.message + detail);
  });
}

/* ---------- vocabulary moderation (ADR-0006) ---------- */
/* Load-on-select + refresh-after-action; no polling, so no REQ stamp — a
   stale response is only guarded against a market switch mid-flight. */
var VOCAB = { market: null, data: null, editing: null };

function openVocabulary(id) {
  VOCAB.market = id;
  VOCAB.data = null;
  VOCAB.editing = null;
  $("vocabWrap").hidden = false;
  $("vocabError").hidden = true;
  $("vocabTitle").textContent = "Vocabulary — " + id;
  renderVocabulary();
  loadVocabulary();
}
function loadVocabulary() {
  var mkt = VOCAB.market;
  if (!mkt) return Promise.resolve();
  return api("/ops/api/markets/" + encodeURIComponent(mkt) + "/vocabulary").then(function (d) {
    if (mkt !== VOCAB.market) return;
    VOCAB.data = d;
    $("vocabError").hidden = true;
    renderVocabulary();
  }).catch(function (err) {
    if (err.status === 403 || mkt !== VOCAB.market) return;
    VOCAB.data = { error: err };
    renderVocabulary();
  });
}
function vocabStores() {
  return (VOCAB.data && VOCAB.data.stores) || [];
}
function vocabStoreCount(item) {
  var needle = String(item).toLowerCase();
  var n = 0;
  vocabStores().forEach(function (s) {
    if ((s.shopItems || []).some(function (i) { return String(i).toLowerCase() === needle; })) n += 1;
  });
  return n;
}
function vocabFail(err) {
  var box = $("vocabError");
  box.hidden = false;
  var detail = "";
  if (err.issues && err.issues.length) {
    var issue = err.issues[0];
    detail = " (" + (issue.path && issue.path.length ? issue.path.join(".") + ": " : "") + issue.message + ")";
  }
  box.textContent = "HTTP " + (err.status || "?") + " — " + err.message + detail;
}
function renderVocabulary() {
  var el = $("vocabBody");
  el.classList.remove("empty");
  var d = VOCAB.data;
  if (!VOCAB.market) { el.classList.add("empty"); el.textContent = "Pick a market's Vocabulary button above."; return; }
  if (!d) { el.classList.add("empty"); el.textContent = "Loading…"; return; }
  if (d.error) { el.innerHTML = emptyState("Vocabulary unavailable", d.error.message); return; }
  var stores = vocabStores();
  if (!stores.length) {
    el.innerHTML = emptyState("No stores yet", "The vocabulary grows as sellers register stores with their shop items.");
    return;
  }
  var html = "";
  stores.forEach(function (s) {
    html += '<div class="vocab-store"><div class="row-main"><span class="title-id">' + esc(s.name) + "</span>" +
      '<span class="row-sub">' + esc(s.id) + "</span></div>";
    var items = s.shopItems || [];
    if (!items.length) {
      html += '<div class="row-sub">no shop items — this store no longer matches intents</div>';
    } else {
      html += '<div class="chips">';
      items.forEach(function (item) {
        var editKey = s.id + "::" + item;
        if (VOCAB.editing === editKey) {
          html += '<span class="pill item"><input class="vocab-edit" id="vocabEditInput" maxlength="64" value="' + esc(item) + '">' +
            '<button type="button" class="pill-x" data-action="vocab-save" data-item="' + esc(item) + '" title="Save rename">✓</button>' +
            '<button type="button" class="pill-x" data-action="vocab-cancel" title="Cancel">×</button></span>';
        } else {
          html += '<span class="pill item" title="Click the item to rename it">' +
            '<span data-action="vocab-edit" data-store="' + esc(s.id) + '" data-item="' + esc(item) + '">' + esc(item) + "</span>" +
            '<button type="button" class="pill-x" data-action="vocab-remove" data-item="' + esc(item) + '" aria-label="Remove ' + esc(item) + '">×</button></span>';
        }
      });
      html += "</div>";
    }
    html += "</div>";
  });
  el.innerHTML = html;
  var input = $("vocabEditInput");
  if (input) {
    input.focus();
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") vocabSave(VOCAB.editing ? VOCAB.editing.split("::").slice(1).join("::") : null);
      else if (ev.key === "Escape") { VOCAB.editing = null; renderVocabulary(); }
    });
  }
}
function vocabRemove(item) {
  if (!VOCAB.market || VOCAB.data && VOCAB.data.error) return;
  var n = vocabStoreCount(item);
  if (!window.confirm("Remove '" + item + "' from " + n + " store" + (n === 1 ? "" : "s") + "?")) return;
  api("/ops/api/markets/" + encodeURIComponent(VOCAB.market) + "/vocabulary", {
    method: "POST",
    body: { action: "remove", item: item }
  }).then(function (r) {
    var affected = (r.affectedStores || []).length;
    feed("vocabulary: removed '" + item + "' from " + affected + " store" + (affected === 1 ? "" : "s"));
    VOCAB.editing = null;
    loadVocabulary();
  }).catch(vocabFail);
}
function vocabSave(from) {
  if (!VOCAB.market || !from) return;
  var input = $("vocabEditInput");
  var to = input ? input.value.trim() : "";
  if (!to || to.length > 64) {
    var box = $("vocabError");
    box.hidden = false;
    box.textContent = "Item names are 1–64 characters.";
    return;
  }
  if (to === from) { VOCAB.editing = null; renderVocabulary(); return; }
  api("/ops/api/markets/" + encodeURIComponent(VOCAB.market) + "/vocabulary", {
    method: "POST",
    body: { action: "rename", from: from, to: to }
  }).then(function (r) {
    var affected = (r.affectedStores || []).length;
    feed("vocabulary: renamed '" + from + "' → '" + to + "' (" + affected + " store" + (affected === 1 ? "" : "s") + ")");
    VOCAB.editing = null;
    loadVocabulary();
  }).catch(vocabFail);
}

/* ---------- market health hero ---------- */
var HERO = [
  { gate: "qualifyingWeeks", label: "Qualifying weeks", get: function (h) { return h.consecutiveQualifyingWeeks; }, fmt: function (v) { return String(v); }, target: function (t) { return "≥ " + t; }, fb: 8 },
  { gate: "completedRuns", label: "Completed runs", get: function (h) { return h.completedRuns; }, fmt: function (v) { return v.toLocaleString("en-NG"); }, target: function (t) { return "≥ " + Number(t).toLocaleString("en-NG"); }, fb: 500 },
  { gate: "disputeRateBps", label: "Dispute rate", get: function (h) { return h.disputeRateBps; }, fmt: bps, target: function (t) { return "< " + bps(t); }, fb: 500 },
  { gate: "zeroTouchRateBps", label: "Zero-touch runs", get: function (h) { return h.zeroTouchRateBps; }, fmt: bps, target: function (t) { return "≥ " + bps(t); }, fb: 6000 },
  { gate: "repeatBuyers", label: "Repeat buyers", get: function (h) { return h.repeatBuyers; }, fmt: function (v) { return String(v); }, target: function (t) { return "≥ " + t; }, fb: 30 }
];
function loadHero() {
  var mkt = market();
  var seq = ++REQ.hero;
  return api("/ops/api/admin/ops-health?market=" + encodeURIComponent(mkt)).then(function (h) {
    if (seq !== REQ.hero || mkt !== market()) return;
    SEL.health = h;
    renderHero();
  }).catch(function (err) {
    if (err.status === 403 || seq !== REQ.hero || mkt !== market()) return;
    SEL.health = { error: err };
    renderHero();
  });
}
function renderGatePill(h) {
  var pill = $("gatePill");
  if (!h || h.error) { pill.className = "pill"; pill.textContent = "gate —"; return; }
  if (h.gate && h.gate.pass) { pill.className = "pill lime"; pill.textContent = "gate passing"; }
  else { pill.className = "pill"; pill.textContent = "gate not met"; }
}
function renderHero() {
  var grid = $("heroGrid");
  var meta = $("heroMeta");
  var h = SEL.health;
  renderGatePill(h);
  if (!h) { grid.innerHTML = ""; meta.textContent = "Expansion gate — ADR-0013 · loading…"; return; }
  if (h.error) {
    grid.innerHTML = archiveDown(h.error)
      ? '<div class="card" style="grid-column:1/-1">' + archiveEmpty() + "</div>"
      : '<div class="card" style="grid-column:1/-1">' + emptyState("Ops health unavailable", h.error.message) + "</div>";
    meta.textContent = "Expansion gate — ADR-0013";
    return;
  }
  grid.innerHTML = HERO.map(function (m) {
    var g = (h.gate && h.gate[m.gate]) || {};
    var pass = !!g.pass;
    var threshold = g.threshold !== undefined ? g.threshold : m.fb;
    return '<div class="hero-card">' +
      '<div class="hero-head"><span class="eyebrow">' + esc(m.label) + "</span>" +
      '<span class="pill hero-pill ' + (pass ? "pass" : "pending") + '">' + (pass ? "pass" : "pending") + "</span></div>" +
      '<span class="hero-num">' + esc(m.fmt(m.get(h))) + "</span>" +
      '<span class="hero-target">target ' + esc(m.target(threshold)) + "</span>" +
      "</div>";
  }).join("");
  meta.textContent = "Expansion gate — ADR-0013 · computed " + timeAgo(h.computedAt);
}

/* ---------- buyer picker (carts/runs are per buyer; the server resolves ids) ---------- */
function setBuyer(id) {
  SEL.buyer = id || null;
  $("buyerInput").value = SEL.buyer || "";
  renderBuyerPill();
}
function renderBuyerPill() {
  $("buyerPill").hidden = !SEL.buyer;
  $("buyerPillText").textContent = SEL.buyer || "";
}

/* ---------- live: market overview ---------- */
function loadOverview() {
  var mkt = market();
  var buyer = SEL.buyer;
  var seq = ++REQ.overview;
  var path = "/ops/api/overview?market=" + encodeURIComponent(mkt);
  if (buyer) path += "&buyerId=" + encodeURIComponent(buyer);
  return api(path).then(function (d) {
    if (seq !== REQ.overview || mkt !== market() || buyer !== SEL.buyer) return;
    SEL.overview = d;
    renderOverview();
  }).catch(function (err) {
    if (err.status === 403 || seq !== REQ.overview || mkt !== market() || buyer !== SEL.buyer) return;
    SEL.overview = { error: err };
    renderOverview();
  });
}
function renderOverview() {
  var el = $("overviewBody");
  var d = SEL.overview;
  el.classList.remove("empty");
  if (!d) { el.classList.add("empty"); el.textContent = "Loading…"; return; }
  if (d.error) { el.innerHTML = emptyState("Overview unavailable", d.error.message); return; }
  var cfg = d.config || {};
  var st = (cfg && cfg.settlement) || {};
  var msLeft = (cfg.closeAt || 0) - Date.now();
  var gateOpen = msLeft > ((cfg.estTripMs || 0) + (cfg.bufferMs || 0));
  var intents = d.intents || [];
  var cart = unwrapCart(d.cart);
  var html = "";
  html += '<div class="kv"><span class="k">Close gate</span><span class="v">' +
    '<span class="title-id">' + esc(countdown(msLeft)) + "</span> " +
    (gateOpen ? '<span class="pill active">checkout open</span>' : '<span class="pill bad">gate closed</span>') + "</span></div>";
  html += '<div class="kv"><span class="k">Closes at</span><span class="v">' + esc(dateTime(cfg.closeAt)) + "</span></div>";
  html += '<div class="kv"><span class="k">Est run / buffer</span><span class="v">' + esc(duration(cfg.estTripMs)) + " / " + esc(duration(cfg.bufferMs)) + "</span></div>";
  html += '<div class="kv"><span class="k">Settlement deductions</span><span class="v">seller commission ' + esc(bps(st.goodsCommissionBps)) +
    ' · runner margin <span class="money">' + esc(money(st.deliveryMarginKobo)) + "</span> (not buyer surcharges)</span></div>";
  html += '<div class="kv"><span class="k">Open intents</span><span class="v">' + intents.length + "</span></div>";
  intents.forEach(function (intent) {
    var tail = intent.id && intent.id.length > 10 ? "…" + intent.id.slice(-8) : intent.id;
    html += '<div class="kv" title="' + esc(intent.id) + '"><span class="k">' + esc(tail) + "</span>" +
      '<span class="v">' + esc(intent.shopItem) + " × " + esc(intent.quantity) + " " + esc(intent.unit) + "</span></div>";
  });
  if (cart) {
    html += '<div class="kv"><span class="k">Cart</span><span class="v">' + statusPill(cart.status) + " " +
      esc(cart.products.length) + " product(s) · deadline " + esc(countdown(cart.deadline - Date.now())) + "</span></div>";
  } else {
    html += '<div class="kv"><span class="k">Cart</span><span class="v row-sub">none open</span></div>';
  }
  el.innerHTML = html;
}

/* ---------- live: runs list ---------- */
function loadRuns() {
  var mkt = market();
  var seq = ++REQ.runs;
  return api("/ops/api/admin/runs?market=" + encodeURIComponent(mkt) + "&limit=20").then(function (d) {
    if (seq !== REQ.runs || mkt !== market()) return;
    SEL.runs = d;
    renderRuns();
  }).catch(function (err) {
    if (err.status === 403 || seq !== REQ.runs || mkt !== market()) return;
    SEL.runs = { error: err };
    renderRuns();
  });
}
function renderRuns() {
  var el = $("runsBody");
  var d = SEL.runs;
  el.classList.remove("empty");
  if (!d) { el.classList.add("empty"); el.textContent = "Loading…"; return; }
  if (d.error) { el.innerHTML = archiveDown(d.error) ? archiveEmpty() : emptyState("Runs unavailable", d.error.message); return; }
  var items = d.items || [];
  if (!items.length) { el.innerHTML = emptyState("No runs yet", "Runs appear here once a cart checks out in " + market() + "."); return; }
  el.innerHTML = items.map(function (r) {
    var live = r.kind === "live";
    var runner = r.runnerId || "unassigned";
    var when = r.startedAt || r.closedAt;
    return '<div class="row-line clickable" data-action="select-run" data-run="' + esc(r.runId) + '" data-buyer="' + esc(r.buyerId || "") + '" title="' + esc(r.runId) + '">' +
      '<div class="row-main">' + statusPill(r.status) +
      '<span class="title-id">' + esc(shortId(r.runId)) + "</span>" +
      '<span class="row-sub">' + esc(runner) + "</span>" +
      '<span class="row-sub">' + esc(timeAgo(when)) + "</span></div>" +
      '<span class="pill ' + (live ? "lime" : "") + '">' + esc(r.kind) + "</span>" +
      "</div>";
  }).join("");
}

/* ---------- run detail ---------- */
/* Never derive run ids client-side: use the picked run, the demo checkout's
   run, or the run the overview API resolved for the active buyer. */
function currentRun() {
  if (SEL.runId || S.runId) return SEL.runId || S.runId;
  var overviewRun = SEL.overview && !SEL.overview.error ? unwrapRun(SEL.overview.run) : null;
  return overviewRun ? overviewRun.id : null;
}
function selectRun(runId, buyerId) {
  SEL.runId = runId;
  if (!SEL.buyer && buyerId) {
    setBuyer(buyerId);
    loadOverview();
  }
  loadRunDetail();
}
function loadRunDetail() {
  var id = currentRun();
  renderSettleTarget();
  var seq = ++REQ.runDetail;
  if (!id) {
    SEL.run = null;
    SEL.runDispute = null;
    renderRun();
    return Promise.resolve();
  }
  return api("/ops/api/runs/" + encodeURIComponent(id)).then(function (data) {
    if (seq !== REQ.runDetail) return;
    SEL.run = unwrapRun(data);
    /* The ops projection carries the live dispute block (reason, raiser,
       server-merged evidence refs) alongside the run — the evidence review
       before any ops settle. */
    SEL.runDispute = (data && data.dispute) || null;
    renderRun();
  }).catch(function (err) {
    if (err.status === 403 || seq !== REQ.runDetail) return;
    SEL.run = { error: err };
    SEL.runDispute = null;
    renderRun();
  });
}
function renderSettleTarget() { $("settleTarget").textContent = currentRun() || "—"; }
function renderRun() {
  var el = $("runBody");
  var run = SEL.run;
  el.classList.remove("empty");
  if (!run) {
    $("settleAwaiting").hidden = true;
    $("settleDisputed").hidden = true;
    el.classList.add("empty");
    el.innerHTML = "<b>No live run.</b>The RunDO retired this run (or it never started) — pick another from the list.";
    return;
  }
  if (run.error) { $("settleAwaiting").hidden = true; $("settleDisputed").hidden = true; el.innerHTML = emptyState("Run unavailable", run.error.message); return; }
  var anyAwaitingPhoto = (run.handoffs || []).some(function (h) { return !!h.awaitingPhoto; });
  $("settleAwaiting").hidden = !anyAwaitingPhoto;
  /* The dispute block rides the ops projection (SEL.runDispute), never the
     client wire — review it here before touching the settle control below. */
  var dispute = SEL.runDispute;
  $("settleDisputed").hidden = !dispute;
  if (dispute) $("settleDisputeReason").textContent = dispute.reason;
  var html = "";
  html += '<div class="row-line"><div class="row-main">' + statusPill(run.status) +
    (run.disputed ? '<span class="pill warn">disputed</span>' : "") +
    '<span class="title-id" title="' + esc(run.id) + '">' + esc(run.id) + "</span></div>" +
    '<div class="row-main"><span class="k" style="font-size:12px;font-weight:700;color:var(--muted)">floor rate</span>' +
    '<span class="money">' + esc(money(run.floorRateKobo)) + "</span></div></div>";
  if (run.finalDeliveryAt) {
    html += '<div class="kv"><span class="k">Final delivery</span><span class="v">' + esc(timeAgo(run.finalDeliveryAt)) +
      ' <span class="row-sub">dispute window 30 min</span></span></div>';
  }
  if (run.route) {
    html += '<div class="row-sub">routed ' + (run.route.distanceMeters / 1000).toFixed(1) + " km · " +
      esc(duration(run.route.durationSeconds * 1000)) + "</div>";
  }
  (run.stops || []).forEach(function (stop, i) {
    html += '<div class="row-line"><div class="row-main"><span class="title-id">Stop ' + (i + 1) + "</span>" +
      "<span>" + esc(stop.sellerName) + " @ " + esc(stop.exchangePoint) + "</span>" +
      '<span class="row-sub">' + esc((stop.shopItems || []).join(", ")) + "</span></div>" +
      statusPill(stop.status) + "</div>";
  });
  (run.handoffs || []).forEach(function (h) {
    var right = statusPill(h.status);
    if (h.status === "pending") {
      /* Photo-required confirm (ADR-0019 as amended): auto-confirm only fires
         with photo evidence; a photoless handoff past its deadline carries
         awaitingPhoto on the wire and stalls until the photo lands. */
      if (h.awaitingPhoto) {
        right += ' <span class="pill warn">waiting for runner photo evidence</span>';
      } else if (h.photoCaptureRef) {
        var left = h.requestedAt + 3 * 60 * 1000 - Date.now();
        right += ' <span class="row-sub">' + (left > 0
          ? "auto-confirms in " + esc(countdown(left)) + " — buyer silence = consent"
          : "auto-confirm due") + "</span>";
      } else {
        right += ' <span class="row-sub">needs runner photo evidence to confirm</span>';
      }
    }
    html += '<div class="row-line"><div class="row-main"><span class="title-id">Handoff</span>' +
      '<span title="' + esc(h.id) + '">' + esc(shortId(h.id)) + "</span>" +
      '<span class="row-sub">with ' + esc(h.counterparty) + " · " + esc(h.exchangePoint) + "</span></div>" +
      '<div class="row-main">' + right + "</div></div>";
    /* The evidence layer per handoff (ADR-0007): the runner's photo as a
       fetchable capture link plus the handshake timestamps. */
    var trail = [];
    if (h.photoCaptureRef) {
      trail.push("photo " + captureLink(h.photoCaptureRef) +
        (h.photoCapturedAt ? " · captured " + esc(timeAgo(h.photoCapturedAt)) : ""));
    } else {
      trail.push("no photo evidence");
    }
    if (h.scannedAt) trail.push("scanned " + esc(timeAgo(h.scannedAt)));
    if (h.confirmedAt) trail.push("confirmed " + esc(timeAgo(h.confirmedAt)) + (h.autoConfirmed ? " (auto — buyer silence = consent)" : ""));
    html += '<div class="row-sub" style="padding:0 0 7px">' + trail.join(" · ") + "</div>";
  });
  if (run.disputed || dispute) {
    html += '<div class="eyebrow" style="padding-top:6px">Dispute — review before settle</div>';
    if (dispute) {
      var refs = (dispute.evidenceRefs || []);
      html += '<div class="kv"><span class="k">Raised by</span><span class="v">' + esc(dispute.raisedByParticipantId || "anonymous") + "</span></div>" +
        '<div class="row-sub" style="padding-bottom:4px">' + esc(dispute.reason) + "</div>" +
        '<div class="row-sub">evidence (' + refs.length + "): " +
          (refs.length ? refs.map(captureLink).join(" · ") : "none attached") + "</div>";
    } else {
      html += '<div class="row-sub">Dispute detail unavailable — reload the run.</div>';
    }
  }
  if (run.location) {
    html += '<div class="kv"><span class="k">Runner location</span><span class="v">' +
      esc(run.location.latitude) + ", " + esc(run.location.longitude) +
      ' <span class="row-sub">' + esc(timeAgo(run.location.observedAt)) + "</span></span></div>";
  }
  if (run.delivery) {
    html += '<div class="kv"><span class="k">Delivery</span><span class="v">' + esc(run.delivery.kind || "") +
      (run.delivery.plusCode ? " · " + esc(run.delivery.plusCode) : "") + "</span></div>";
  }
  el.innerHTML = html;
}

/* ---------- ops settle ---------- */
function opsSettle() {
  var run = currentRun();
  if (!run) { $("settleResult").textContent = "no run selected — pick a run from the list."; return; }
  var mode = $("settleMode").value;
  var body = { mode: mode };
  var reason = $("settleReason").value.trim();
  if (reason) body.reason = reason;
  if ($("settleAmbiguous").checked) {
    body.ambiguous = true;
    var lossText = $("settleLoss").value.trim();
    if (lossText) {
      var loss = nairaToKobo(lossText);
      if (loss === null) { $("settleResult").textContent = "platform loss must be a valid ₦ amount"; return; }
      body.requestedPlatformLossKobo = loss;
    }
  }
  $("settleGo").disabled = true;
  api("/ops/api/runs/" + encodeURIComponent(run) + "/settle", { method: "POST", body: body })
    .then(function (j) {
      $("settleResult").textContent = JSON.stringify(j, null, 2);
      var s = j.settlement || j;
      if (s && s.runnerKobo !== undefined) {
        feed("settlement released (" + s.mode + "): runner " + money(s.runnerKobo) +
             ", platform " + money(s.platformKobo) + ", buyer refund " + money(s.buyerRefundKobo));
      } else {
        feed("settlement released for " + run);
      }
      loadRunDetail();
    })
    .catch(function (err) {
      $("settleResult").textContent = "HTTP " + (err.status || "?") + " — " + err.message;
      feed("ops settle failed (HTTP " + (err.status || "?") + ")");
    })
    .then(function () { $("settleGo").disabled = false; });
}

/* ---------- oversight tabs ---------- */
var TABS = [
  { id: "disputes", label: "Disputes" },
  { id: "settlements", label: "Settlements" },
  { id: "ledger", label: "Ledger" },
  { id: "reputation", label: "Reputation" },
  { id: "payments", label: "Payments" },
  { id: "holds", label: "Holds" },
  { id: "refunds", label: "Refunds" },
  { id: "resets", label: "Resets" }
];
function renderTabs() {
  $("oversightTabs").innerHTML = TABS.map(function (t) {
    return '<button type="button" class="pill tab' + (SEL.tab === t.id ? " on" : "") + '" data-action="tab" data-tab="' + t.id + '">' + t.label + "</button>";
  }).join("");
}
function openTab(id) {
  SEL.tab = id;
  renderTabs();
  if (id === "reputation") { renderReputationTab(); return; }
  if (id === "resets") { loadResets(); return; }
  loadTab(id);
}
function tabPath(id) {
  return "/ops/api/admin/" + id + "?market=" + encodeURIComponent(market()) +
    "&limit=" + PAGE_SIZE + "&offset=" + (SEL.pages[id] || 0);
}
function loadTab(id) {
  var mkt = market();
  var seq = ++REQ.tab;
  $("tabBody").classList.add("empty");
  $("tabBody").textContent = "Loading…";
  return api(tabPath(id)).then(function (d) {
    if (seq !== REQ.tab) return;
    SEL.tabData[id] = d;
    if (SEL.tab !== id || mkt !== market()) return;
    renderTabBody(id, d);
  }).catch(function (err) {
    if (err.status === 403 || seq !== REQ.tab) return;
    if (SEL.tab !== id || mkt !== market()) return;
    var body = $("tabBody");
    body.classList.remove("empty");
    body.innerHTML = archiveDown(err) ? archiveEmpty()
      : paymentsDown(err) ? paymentsEmpty()
      : emptyState("Could not load " + id, err.message);
  });
}
function pagerHtml(id, d) {
  var offset = d.offset || 0;
  var total = d.total || 0;
  var end = Math.min(offset + (d.items ? d.items.length : 0), total);
  return '<div class="pager"><span class="muted-line">' + (total ? (offset + 1) + "–" + end : 0) + " of " + total + "</span>" +
    '<button type="button" class="secondary compact" data-action="page" data-tab="' + id + '" data-dir="-1"' + (offset <= 0 ? " disabled" : "") + ">Prev</button>" +
    '<button type="button" class="secondary compact" data-action="page" data-tab="' + id + '" data-dir="1"' + (offset + PAGE_SIZE >= total ? " disabled" : "") + ">Next</button></div>";
}
function captureLink(ref) {
  var prefix = "r2://archive/";
  if (ref.indexOf(prefix) === 0) {
    var key = ref.slice(prefix.length);
    var name = key.split("/").pop();
    return '<a href="/captures/' + encodeURIComponent(key) + '" target="_blank" rel="noopener">' + esc(name) + "</a>";
  }
  return "<span>" + esc(ref) + "</span>";
}
function renderTabBody(id, d) {
  var body = $("tabBody");
  body.classList.remove("empty");
  var items = d.items || [];
  var html = "";
  if (!items.length) {
    html = emptyState("Nothing here yet", "No " + id + " recorded for " + market() + ".");
  } else if (id === "disputes") {
    html = items.map(function (x) {
      var evidence = (x.evidenceRefs || []).map(captureLink).join(" · ");
      return '<div class="row-line"><div class="row-main">' + statusPill(x.status) +
        '<span class="title-id" title="' + esc(x.runId) + '">' + esc(shortId(x.runId)) + "</span>" +
        '<span class="row-sub">raised by ' + esc(x.raisedByParticipantId) + "</span>" +
        (x.ambiguous ? '<span class="pill warn">ambiguous</span>' : "") +
        '<span class="row-sub">' + esc(timeAgo(x.createdAt)) + "</span></div>" +
        '<div class="row-main"><span class="row-sub">absorbed loss</span> <span class="money">' + esc(money(x.absorbedLossKobo)) + "</span></div></div>" +
        (evidence ? '<div class="row-sub" style="padding:0 0 7px">evidence: ' + evidence + "</div>" : "");
    }).join("");
  } else if (id === "settlements") {
    html = items.map(function (x) {
      return '<div style="padding:7px 0;border-bottom:1px solid var(--line)">' +
        '<div class="row-main">' + statusPill(x.mode) +
        '<span class="title-id" title="' + esc(x.runId) + '">' + esc(shortId(x.runId)) + "</span>" +
        '<span class="row-sub">released ' + esc(timeAgo(x.releasedAt)) + "</span></div>" +
        '<div class="chips" style="margin-top:5px">' +
        '<span class="chip">goods <span class="money">' + esc(money(x.goodsTotalKobo)) + "</span></span>" +
        '<span class="chip">runner <span class="money">' + esc(money(x.runnerKobo)) + "</span></span>" +
        '<span class="chip">platform <span class="money">' + esc(money(x.platformKobo)) + "</span></span>" +
        '<span class="chip">buyer refund <span class="money">' + esc(money(x.buyerRefundKobo)) + "</span></span>" +
        '<span class="chip">loss <span class="money">' + esc(money(x.platformLossKobo)) + "</span></span>" +
        "</div></div>";
    }).join("");
  } else if (id === "ledger") {
    html = items.map(function (x) {
      return '<div class="row-line"><div class="row-main"><span class="title-id">' + esc(x.account) + "</span>" +
        '<span class="row-sub">' + esc(x.partyId || "platform") + "</span>" +
        '<span class="row-sub">' + esc(x.memo) + "</span></div>" +
        '<div class="row-main">' +
        (x.debitKobo ? '<span class="row-sub">− ' + esc(money(x.debitKobo)) + "</span>" : "") +
        (x.creditKobo ? '<span class="money">+ ' + esc(money(x.creditKobo)) + "</span>" : "") +
        "</div></div>";
    }).join("");
  } else if (id === "payments") {
    html = items.map(function (x) {
      return '<div style="padding:7px 0;border-bottom:1px solid var(--line)">' +
        '<div class="row-main">' + statusPill(x.status) +
        '<span class="pill">' + esc(x.account) + "</span>" +
        '<span class="title-id" title="' + esc(x.runId) + '">' + esc(shortId(x.runId)) + "</span>" +
        '<span class="row-sub">' + esc(x.partyId) + "</span>" +
        '<span class="row-sub">' + esc(timeAgo(x.createdAt)) + "</span></div>" +
        '<div class="chips" style="margin-top:5px">' +
        '<span class="chip">amount <span class="money">' + esc(money(x.amountKobo)) + "</span></span>" +
        '<span class="chip">attempts ' + esc(x.attempts) + "</span>" +
        (x.providerRef ? '<span class="chip">ref <code>' + esc(x.providerRef) + "</code></span>" : "") +
        "</div>" +
        (x.failureReason ? '<div class="row-sub" style="padding-top:5px">' + esc(x.failureReason) + "</div>" : "") +
        (x.status === "failed" || x.status === "pending" ? '<button type="button" class="secondary compact" data-action="dispatch-replay" data-id="' + esc(x.id) + '">Replay through dispatcher</button>' : "") +
        "</div>";
    }).join("");
  } else if (id === "holds" || id === "refunds") {
    html = items.map(function (x) {
      return '<div class="row-line"><div class="row-main">' + statusPill(x.status) + '<span class="title-id">' + esc(x.id) + '</span><span class="row-sub">' + esc(x.buyerId || x.holdId || "") + '</span></div><span class="money">' + esc(money(x.amountKobo)) + '</span></div>';
    }).join("");
  }
  body.innerHTML = html + (items.length || d.total ? pagerHtml(id, d) : "");
}
function changePage(id, dir) {
  SEL.pages[id] = Math.max(0, (SEL.pages[id] || 0) + dir * PAGE_SIZE);
  loadTab(id);
}

/* ---------- reputation tab ---------- */
function renderReputationTab() {
  var body = $("tabBody");
  body.classList.remove("empty");
  body.innerHTML =
    '<div class="form-grid">' +
    '<label class="field">Participant<input id="repParticipant" placeholder="participant id, e.g. buyer:…"></label>' +
    '<label class="field">Role<select id="repRole"><option>buyer</option><option>runner</option><option>seller</option></select></label>' +
    "</div>" +
    '<div class="form-actions"><button type="button" class="secondary" id="repGo">Compute</button></div>' +
    '<div id="repResult">' + emptyState("No computation yet", "Standing is computed from the durable record — completed runs, abort rates, dispute outcomes. Never user-entered ratings.") + "</div>";
  $("repGo").addEventListener("click", loadReputation);
}
function loadReputation() {
  var participant = $("repParticipant").value.trim();
  var role = $("repRole").value;
  var box = $("repResult");
  if (!participant) { box.innerHTML = emptyState("Participant required", "Enter a participant id to compute standing."); return; }
  api("/ops/api/reputation?participant=" + encodeURIComponent(participant) + "&role=" + encodeURIComponent(role))
    .then(function (r) {
      feed("reputation computed for " + participant);
      box.innerHTML =
        '<div class="kv"><span class="k">Standing</span><span class="v"><span class="money">' +
          esc(Number(r.standingBps).toLocaleString("en-NG")) + " bps</span> · " + esc(bps(r.standingBps)) + "</span></div>" +
        '<div class="kv"><span class="k">Abort rate</span><span class="v">' + esc(bps(r.abortRateBps)) + " (" + esc(r.abortRateBps) + " bps)</span></div>" +
        '<div class="kv"><span class="k">Completed runs</span><span class="v">' + esc(r.completedTrips) + "</span></div>" +
        '<div class="kv"><span class="k">Aborted runs</span><span class="v">' + esc(r.abortedTrips) + "</span></div>" +
        '<div class="kv"><span class="k">Disputed runs</span><span class="v">' + esc(r.disputedTrips) + "</span></div>" +
        '<div class="kv"><span class="k">Strikes</span><span class="v">' + esc(r.strikes) + "</span></div>" +
        "<pre>" + esc(JSON.stringify(r, null, 2)) + "</pre>";
    })
    .catch(function (err) {
      if (err.status === 403) return;
      box.innerHTML = archiveDown(err) ? archiveEmpty() : emptyState("Reputation unavailable", err.message);
      feed("reputation unavailable (archive not configured?)");
    });
}

/* ---------- device resets tab (ADR-0022: ops-approved device reset) ---------- */
/* The queue is the identity worker's internal seam, reached through the
   /ops/api/device-resets proxy — never the public /auth/* request route. */
function identityDown(err) { return !!err && err.status === 503 && err.code === "identity-unavailable"; }
function identityEmpty() {
  return emptyState("Identity unavailable", "The identity service is not configured or unreachable — reset decisions are safe to retry once it is back.");
}
function loadResets() {
  var body = $("tabBody");
  body.classList.add("empty");
  body.textContent = "Loading…";
  return api("/ops/api/device-resets?status=pending").then(function (d) {
    if (SEL.tab !== "resets") return;
    renderResets((d && d.requests) || []);
  }).catch(function (err) {
    if (err.status === 403 || SEL.tab !== "resets") return;
    body.classList.remove("empty");
    body.innerHTML = identityDown(err) ? identityEmpty() : emptyState("Could not load resets", err.message);
  });
}
function renderResets(requests) {
  var body = $("tabBody");
  body.classList.remove("empty");
  if (!requests.length) {
    body.innerHTML = emptyState("No pending resets",
      "A request lands here when a participant loses their device (POST /auth/device-reset). Approving revokes that participant's device credentials and live sessions so they can re-enroll on the replacement device.");
    return;
  }
  body.innerHTML = requests.map(function (r) {
    return '<div class="row-line"><div class="row-main"><span class="title-id">' + esc(r.participantId) + "</span>" +
      '<span class="row-sub">' + esc(r.reason) + "</span>" +
      '<span class="row-sub">' + esc(timeAgo(r.createdAt)) + "</span></div>" +
      '<div class="row-main">' +
      '<button type="button" class="compact" data-action="reset-decision" data-id="' + esc(r.id) + '" data-decision="approved" data-participant="' + esc(r.participantId) + '">Approve</button>' +
      '<button type="button" class="secondary compact" data-action="reset-decision" data-id="' + esc(r.id) + '" data-decision="rejected">Reject</button>' +
      "</div></div>";
  }).join("") +
    '<p class="helper">Approve revokes every device credential and live session for the participant; reject leaves them untouched. A decision is final — a resolved request answers 409 to further decisions.</p>';
}
function decideReset(id, decision, participantId) {
  if (!id) return;
  if (decision === "approved" &&
      !window.confirm("Approve the device reset for " + (participantId || id) + "? This revokes their device credentials and live sessions.")) {
    return;
  }
  api("/ops/api/device-resets/" + encodeURIComponent(id) + "/decision", {
    method: "POST",
    body: { decision: decision }
  }).then(function (r) {
    feed("device reset " + decision + " for " + (r.participantId || id) +
      (decision === "approved"
        ? " — revoked " + (r.revokedCredentials || 0) + " credential(s), " + (r.revokedSessions || 0) + " session(s)"
        : ""));
    loadResets();
  }).catch(function (err) {
    if (err.status === 403) return;
    feed("device-reset decision failed (HTTP " + (err.status || "?") + (err.message ? " — " + err.message : "") + ")");
    loadResets(); // e.g. 409 reset-already-resolved — refresh the queue honestly
  });
}

/* ---------- demo driver (dev only; deterministic ids, public API, no token) ---------- */
function demoId(prefix) { S.seq += 1; return prefix + "-" + Date.now().toString(36) + "-" + S.seq; }

function postIntent() {
  S.market = market();
  S.intentId = demoId("intent");
  command({ type: "intent.posted", intentId: S.intentId, shopItem: "Tomatoes", quantity: 2, unit: "kg",
            priceBand: { minKobo: 120000, maxKobo: 180000 }, note: "Firm, ripe tomatoes please",
            market: S.market, buyerId: "buyer:demo" })
    .then(function (r) { if (!r.ok) return fail("intent.posted", r);
      $("intentId").textContent = S.intentId; feed("intent.posted " + S.intentId); refreshLive(); });
}
function offerProduct() {
  if (!S.intentId) return feed("post an intent first");
  S.productId = demoId("product");
  call("POST", "/markets/" + encodeURIComponent(S.market) + "/offers",
       { productId: S.productId, intentId: S.intentId, market: S.market, shopItem: "Tomatoes",
         quantity: 2, unit: "kg", priceKobo: 165000, sellerName: "Amina's Fresh Store",
         exchangePoint: S.market + " Market, Stall B14" })
    .then(function (r) { if (!r.ok) return fail("offer", r);
      $("productId").textContent = S.productId; feed("product offered " + S.productId + " at ₦1,650.00"); refreshLive(); });
}
function negotiate() {
  if (!S.productId) return feed("offer a product first");
  command({ type: "negotiation.price-adjusted", productId: S.productId, by: "buyer", priceKobo: 160000, at: Date.now() })
    .then(function (r) { if (!r.ok) return fail("negotiation", r); feed("buyer adjusted price to ₦1,600.00"); refreshLive(); });
}
function acceptProduct() {
  if (!S.productId) return feed("offer a product first");
  command({ type: "product.accepted", productId: S.productId })
    .then(function (r) { if (!r.ok) return fail("accept", r); return r.json(); })
    .then(function (event) { if (!event) return;
      /* cart.updated carries the buyer's cart id — never derive it here. */
      S.cartId = (event.cart && event.cart.id) || null;
      $("cartId").textContent = S.cartId || "—";
      feed("product accepted into " + (S.cartId || "the cart")); refreshLive(); });
}
function checkout() {
  if (!S.cartId) return feed("accept a product first");
  command({ type: "checkout.requested", cartId: S.cartId, buyerId: "buyer:demo",
            delivery: { kind: "plus-code", plusCode: "6FR5+8X Lagos" } })
    .then(function (r) { if (!r.ok) return fail("checkout", r); return r.json(); })
    .then(function (event) { if (!event) return;
      S.runId = event.runId; SEL.runId = event.runId; $("runId").textContent = S.runId;
      feed("checkout accepted at floor rate ₦" + (event.floorRateKobo / 100).toFixed(2) + " → run " + event.runId);
      loadRunDetail(); refreshLive(); });
}
function initiateHandoff() {
  S.lastHandoffId = demoId("handoff");
  call("POST", "/runs/" + encodeURIComponent(currentRun()) + "/handoffs",
       { handoffId: S.lastHandoffId, exchangePointId: market() + " Market, Stall B14", counterparty: "Amina's Fresh Store" })
    .then(function (r) { if (!r.ok) return fail("handoff initiate", r);
      feed("handoff " + S.lastHandoffId + " initiated — attach photo, then scan (confirm needs photo evidence)"); loadRunDetail(); });
}
function attachPhoto() {
  if (!S.lastHandoffId) return feed("initiate a handoff first");
  var run = currentRun();
  call("POST", "/runs/" + encodeURIComponent(run) + "/handoffs/" + S.lastHandoffId + "/photo",
       { type: "handoff.photo-captured", handoffId: S.lastHandoffId, photoCaptureRef: "r2://archive/captures/" + S.lastHandoffId + ".jpg", capturedAt: Date.now() })
    .then(function (r) { if (!r.ok) return fail("photo", r); return r.json(); })
    .then(function (event) { if (!event) return;
      /* Photo attach on a scanned handoff IS the confirm — the run.updated
         payload carries the handoff's new status. */
      var wire = unwrapRun(event);
      var handoff = wire && (wire.handoffs || []).filter(function (h) { return h.id === S.lastHandoffId; })[0];
      var confirmed = !!handoff && handoff.status === "confirmed";
      $("driverInfo").hidden = true;
      feed(confirmed
        ? "photo evidence attached — handoff confirmed (" + S.lastHandoffId + ")"
        : "photo evidence attached (" + S.lastHandoffId + ") — scan the QR challenge to confirm");
      loadRunDetail(); });
}
function scanChallenge() {
  var run = currentRun();
  if (!S.lastHandoffId) return feed("initiate a handoff first");
  command({ type: "handoff.challenge-scanned", handoffId: S.lastHandoffId, runId: run, scannedAt: Date.now() })
    .then(function (r) {
      if (r.ok) {
        $("driverInfo").hidden = true;
        feed("QR challenge scanned — handoff confirmed");
        loadRunDetail();
        return;
      }
      return r.text().then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (r.status === 409 && data && data.error === "photo-required") {
          /* The scan is recorded (scannedAt persisted); the photo is the
             confirm act. Informational state, not an error. */
          driverInfo("scan recorded — awaiting photo: attach photo evidence to confirm " + S.lastHandoffId);
          feed("scan recorded — awaiting photo (" + S.lastHandoffId + ")");
          loadRunDetail();
          return;
        }
        $("driverInfo").hidden = true;
        var box = $("driverError");
        box.hidden = false;
        box.textContent = "scan → HTTP " + r.status + ": " + text;
        feed("scan failed (HTTP " + r.status + ")");
      });
    });
}
function locationTick() {
  command({ type: "run.location-updated", runId: currentRun(), latitude: 6.4541, longitude: 3.3947, observedAt: Date.now() })
    .then(function (r) { if (!r.ok) return fail("location", r); feed("runner location tick (6.4541, 3.3947)"); });
}
function finalDelivery() {
  call("POST", "/runs/" + encodeURIComponent(currentRun()) + "/delivery/final", {})
    .then(function (r) {
      if (r.ok) { feed("final delivery — dispute window (30 min) armed"); loadRunDetail(); return; }
      return r.text().then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (r.status === 409 && data && data.error === "photo-required") {
          driverInfo("final delivery blocked — a handoff is still pending photo evidence");
          feed("final delivery refused (photo-required)");
          loadRunDetail();
          return;
        }
        $("driverInfo").hidden = true;
        var box = $("driverError");
        box.hidden = false;
        box.textContent = "final delivery → HTTP " + r.status + ": " + text;
        feed("final delivery failed (HTTP " + r.status + ")");
      });
    });
}

/* ---------- production pilot: bounded telemetry + manageable entities ---------- */
var observerSocket = null;
function loadTelemetry() {
  return api("/ops/api/telemetry" + (S.market ? "?market=" + encodeURIComponent(S.market) : "")).then(function (data) {
    var items = data.items || [];
    $("telemetryBody").innerHTML = items.length ? '<div class="hero-grid">' + items.map(function (r) {
      return '<div class="metric"><span class="pill ' + (r.live ? "active" : "warn") + '">' + (r.live ? "live" : "stale") + '</span><b>' + esc(r.objectClass) + '</b><div class="title-id">' + esc(r.instanceId) + '</div><div class="row-sub">' + esc(r.objectName) + ' · ' + esc(r.market || "no market") + '</div><div class="kv"><span class="k">Connections</span><span class="v">' + r.connectionCount + '</span></div><div class="row-sub">last ' + new Date(r.lastActivityAt).toLocaleString() + '<br>alarm ' + (r.alarmAt ? new Date(r.alarmAt).toLocaleString() : "none") + '</div><button type="button" class="secondary compact" data-action="observe" data-class="' + esc(r.objectClass) + '" data-name="' + esc(r.objectName) + '">Attach observer</button></div>';
    }).join("") + "</div>" : emptyState("No heartbeats", "Instances appear after explicit DO activity; namespaces are never enumerated.");
  }).catch(function (err) { $("telemetryBody").innerHTML = emptyState("Telemetry unavailable", err.message); });
}
function observeInstance(className, objectName) {
  if (observerSocket) observerSocket.close();
  var protocol = location.protocol === "https:" ? "wss:" : "ws:";
  observerSocket = new WebSocket(protocol + "//" + location.host + "/ops/api/telemetry/" + encodeURIComponent(className) + "/" + encodeURIComponent(objectName) + "/ws");
  observerSocket.onopen = function () { feed("authenticated observer attached to " + objectName); observerSocket.send(JSON.stringify({ type: "ping" })); };
  observerSocket.onmessage = function (ev) { if (String(ev.data).indexOf("pong") >= 0) feed("heartbeat pong · " + objectName); };
  observerSocket.onerror = function () { feed("observer connection failed"); };
}
function loadStores() {
  return api("/ops/api/stores" + (S.market ? "?market=" + encodeURIComponent(S.market) : "")).then(function (data) {
    $("storesBody").innerHTML = (data.items || []).map(function (s) { return '<div class="row-line"><div class="row-main"><b>' + esc(s.name) + '</b><div class="row-sub">' + esc(s.id) + ' · ' + esc(s.sellerId) + ' · ' + esc(s.exchangePoint) + '</div><div>' + (s.shopItems || []).map(function (i) { return '<span class="pill">' + esc(i.name) + '</span> <button class="compact secondary" data-action="item-delete" data-store="' + esc(s.id) + '" data-item="' + esc(i.id) + '">remove</button>'; }).join(" ") + '</div></div><button class="compact secondary" data-action="item-add" data-store="' + esc(s.id) + '">Add item</button><button class="compact secondary" data-action="store-delete" data-store="' + esc(s.id) + '">Delete</button></div>'; }).join("") || "—";
  });
}
function loadPools() {
  return api("/ops/api/runner-pools").then(function (data) {
    $("poolsBody").innerHTML = (data.items || []).map(function (p) { return '<div class="row-line"><div class="row-main"><b>' + esc(p.name) + '</b><div class="row-sub">' + esc(p.id) + ' · ' + esc(p.marketId) + '</div>' + (p.members || []).map(function (m) { return '<span class="pill">' + esc(m.runnerId) + '</span> <button class="compact secondary" data-action="member-remove" data-pool="' + esc(p.id) + '" data-runner="' + esc(m.runnerId) + '">remove</button>'; }).join(" ") + '</div><button class="compact secondary" data-action="member-add" data-pool="' + esc(p.id) + '">Add runner</button><button class="compact secondary" data-action="pool-delete" data-pool="' + esc(p.id) + '">Delete</button></div>'; }).join("") || "—";
  });
}
function loadPilot() { loadTelemetry(); loadStores(); loadPools(); }

/* ---------- refresh loop ---------- */
function refreshLive() {
  renderSettleTarget();
  loadOverview();
  loadHero();
  loadRuns();
  loadRunDetail();
}
/* 1s tick: re-render cached views so countdowns (close gate, handoff auto-confirm) move. */
function tick() {
  if (SEL.overview && !SEL.overview.error) renderOverview();
  if (SEL.run && !SEL.run.error) renderRun();
}

/* ---------- wiring ---------- */
function init() {
  renderTabs();
  $("marketSel").addEventListener("change", function () {
    S.market = $("marketSel").value;
    S.runId = null;
    SEL.runId = null;
    SEL.run = null;
    SEL.overview = null;
    SEL.health = null;
    SEL.runs = null;
    SEL.tabData = {};
    SEL.pages = { disputes: 0, settlements: 0, ledger: 0, payments: 0 };
    setBuyer(null);
    refreshLive();
    openTab(SEL.tab);
  });
  $("signOut").addEventListener("click", function () {
    fetch("/ops/auth/sign-out", { method: "POST" }).finally(function () { location = "/ops/login"; });
  });
  $("marketsOpen").addEventListener("click", function () { $("marketsDialog").showModal(); });
  $("marketsClose").addEventListener("click", function () { $("marketsDialog").close(); });
  $("vocabRefresh").addEventListener("click", loadVocabulary);
  $("settleGo").addEventListener("click", opsSettle);
  $("buyerView").addEventListener("click", function () {
    setBuyer($("buyerInput").value.trim());
    loadOverview();
  });
  $("buyerClear").addEventListener("click", function () {
    setBuyer(null);
    loadOverview();
  });
  $("buyerInput").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") $("buyerView").click();
  });
  $("settleMode").addEventListener("change", function () {
    if ($("settleMode").value === "disputed") $("settleAmbiguous").checked = true;
    $("settleLossField").hidden = !$("settleAmbiguous").checked;
  });
  $("settleAmbiguous").addEventListener("change", function () {
    $("settleLossField").hidden = !$("settleAmbiguous").checked;
  });
  $("pilotPanel").addEventListener("toggle", function () { if ($("pilotPanel").open) loadPilot(); });
  $("telemetryRefresh").addEventListener("click", loadTelemetry);
  $("storeCreate").addEventListener("click", function () {
    api("/ops/api/stores", { method: "POST", body: { marketId: $("storeMarket").value.trim(), sellerId: $("storeSeller").value.trim(), name: $("storeName").value.trim(), exchangePoint: $("storePoint").value.trim() } }).then(loadStores).catch(function (e) { feed(e.message); });
  });
  $("poolCreate").addEventListener("click", function () {
    api("/ops/api/runner-pools", { method: "POST", body: { marketId: $("poolMarket").value.trim(), name: $("poolName").value.trim(), active: true } }).then(loadPools).catch(function (e) { feed(e.message); });
  });
  $("participantGo").addEventListener("click", function () {
    api("/ops/api/participants/" + encodeURIComponent($("participantLookup").value.trim())).then(function (data) { $("participantBody").textContent = JSON.stringify(data, null, 2); }).catch(function (e) { $("participantBody").textContent = e.message; });
  });
  document.addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest("[data-action]") : null;
    if (!t) return;
    var action = t.getAttribute("data-action");
    if (action === "select-run") selectRun(t.getAttribute("data-run"), t.getAttribute("data-buyer"));
    else if (action === "edit-market") openMarketForm(t.getAttribute("data-id"));
    else if (action === "new-market") openMarketForm(null);
    else if (action === "vocab-market") openVocabulary(t.getAttribute("data-id"));
    else if (action === "vocab-remove") vocabRemove(t.getAttribute("data-item"));
    else if (action === "vocab-edit") { VOCAB.editing = t.getAttribute("data-store") + "::" + t.getAttribute("data-item"); renderVocabulary(); }
    else if (action === "vocab-save") vocabSave(t.getAttribute("data-item"));
    else if (action === "vocab-cancel") { VOCAB.editing = null; renderVocabulary(); }
    else if (action === "tab") openTab(t.getAttribute("data-tab"));
    else if (action === "page") changePage(t.getAttribute("data-tab"), Number(t.getAttribute("data-dir")));
    else if (action === "observe") observeInstance(t.getAttribute("data-class"), t.getAttribute("data-name"));
    else if (action === "item-add") { var itemName = prompt("Shop item name"); if (itemName) api("/ops/api/stores/" + encodeURIComponent(t.getAttribute("data-store")) + "/items", { method: "POST", body: { name: itemName, attributes: {}, active: true } }).then(loadStores); }
    else if (action === "item-delete") api("/ops/api/stores/" + encodeURIComponent(t.getAttribute("data-store")) + "/items/" + encodeURIComponent(t.getAttribute("data-item")), { method: "DELETE" }).then(loadStores);
    else if (action === "store-delete" && confirm("Delete this manageable store?")) api("/ops/api/stores/" + encodeURIComponent(t.getAttribute("data-store")), { method: "DELETE" }).then(loadStores);
    else if (action === "member-add") { var runner = $("memberRunner").value.trim(); if (runner) api("/ops/api/runner-pools/" + encodeURIComponent(t.getAttribute("data-pool")) + "/members/" + encodeURIComponent(runner), { method: "PUT" }).then(loadPools); }
    else if (action === "member-remove") api("/ops/api/runner-pools/" + encodeURIComponent(t.getAttribute("data-pool")) + "/members/" + encodeURIComponent(t.getAttribute("data-runner")), { method: "DELETE" }).then(loadPools);
    else if (action === "pool-delete" && confirm("Delete this runner pool?")) api("/ops/api/runner-pools/" + encodeURIComponent(t.getAttribute("data-pool")), { method: "DELETE" }).then(loadPools);
    else if (action === "dispatch-replay") api("/ops/api/admin/payments/" + encodeURIComponent(t.getAttribute("data-id")) + "/replay", { method: "POST" }).then(function () { feed("dispatch replay applied"); openTab("payments"); });
    else if (action === "reset-decision") decideReset(t.getAttribute("data-id"), t.getAttribute("data-decision"), t.getAttribute("data-participant"));
  });
  $("drvIntent").addEventListener("click", postIntent);
  $("drvOffer").addEventListener("click", offerProduct);
  $("drvNegotiate").addEventListener("click", negotiate);
  $("drvAccept").addEventListener("click", acceptProduct);
  $("drvCheckout").addEventListener("click", checkout);
  $("drvHandoff").addEventListener("click", initiateHandoff);
  $("drvPhoto").addEventListener("click", attachPhoto);
  $("drvScan").addEventListener("click", scanChallenge);
  $("drvLocation").addEventListener("click", locationTick);
  $("drvFinal").addEventListener("click", finalDelivery);

  loadMarkets().then(function () {
    refreshLive();
    openTab("disputes");
  });
  setInterval(refreshLive, 5000);
  setInterval(tick, 1000);
}
init();
</script>
</body>
</html>`;
