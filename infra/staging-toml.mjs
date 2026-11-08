#!/usr/bin/env node
/** Apply or verify public staging-only Wrangler values. Never handles secrets. */

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const mode = process.argv[2];
if (!["apply", "check"].includes(mode)) {
  console.error("usage: node infra/staging-toml.mjs apply|check");
  process.exit(2);
}

const required = [
  "EDGE_PUBLIC_URL",
  "ARCHIVE_PUBLIC_URL",
  "IDENTITY_PUBLIC_URL",
  "PAYMENTS_PUBLIC_URL",
  "NOTIFICATIONS_PUBLIC_URL",
  "RESEND_FROM_EMAIL",
  "HYPERDRIVE_ID",
  "MARKET_CONFIG_KV_ID",
  "PAYMENT_DISPATCHER",
  "FACE_VERIFIER",
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}
if (!["stub", "flutterwave"].includes(process.env.PAYMENT_DISPATCHER)) {
  throw new Error("PAYMENT_DISPATCHER must be stub or flutterwave");
}
if (!["stub", "hybrid"].includes(process.env.FACE_VERIFIER)) {
  throw new Error("FACE_VERIFIER must be stub or hybrid");
}

function httpsUrl(name, { originOnly = false } = {}) {
  let url;
  try {
    url = new URL(process.env[name]);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  const local = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(url.hostname)
    || url.hostname.endsWith(".localhost");
  const example = url.hostname === "example.com" || url.hostname.endsWith(".example.com");
  if (url.protocol !== "https:" || local || example || url.username || url.password
      || (originOnly && (url.pathname !== "/" || url.search || url.hash))) {
    throw new Error(`${name} must be a real non-local HTTPS ${originOnly ? "origin" : "URL"} without credentials or example.com`);
  }
  return url;
}

const workerOriginNames = [
  "EDGE_PUBLIC_URL",
  "ARCHIVE_PUBLIC_URL",
  "IDENTITY_PUBLIC_URL",
  "PAYMENTS_PUBLIC_URL",
  "NOTIFICATIONS_PUBLIC_URL",
];
const workerOrigins = workerOriginNames.map((name) => httpsUrl(name, { originOnly: true }).origin);
if (new Set(workerOrigins).size !== workerOrigins.length) {
  throw new Error("The five public Worker origins must be distinct");
}
if (process.env.FACE_VERIFIER === "hybrid") {
  for (const name of [
    "SMILEID_ENV",
    "SMILEID_CALLBACK_URL",
    "SMILEID_PRIVACY_NOTICE_URL",
    "BIOMETRICS_SERVICE_URL",
  ]) {
    if (!process.env[name]) throw new Error(`${name} is required for hybrid staging`);
  }
  if (process.env.SMILEID_ENV !== "sandbox") throw new Error("SMILEID_ENV must be sandbox in staging");
  httpsUrl("SMILEID_PRIVACY_NOTICE_URL");
  httpsUrl("BIOMETRICS_SERVICE_URL", { originOnly: true });
  const callback = httpsUrl("SMILEID_CALLBACK_URL");
  if (callback.href !== `${workerOrigins[0]}/callbacks/smileid`) {
    throw new Error("SMILEID_CALLBACK_URL must equal EDGE_PUBLIC_URL/callbacks/smileid");
  }
}

const files = Object.fromEntries([
  "edge",
  "archive",
  "identity",
  "payments",
  "notifications",
].map((name) => [name, {
  path: path.join(root, `infra/wrangler.${name}.toml`),
  text: fs.readFileSync(path.join(root, `infra/wrangler.${name}.toml`), "utf8"),
}]));

function bounds(text, header) {
  const start = text.indexOf(`${header}\n`);
  if (start < 0) throw new Error(`missing ${header}`);
  const bodyStart = start + header.length + 1;
  const remainder = text.slice(bodyStart);
  const next = remainder.search(/^\[/m);
  const end = next < 0 ? text.length : bodyStart + next;
  return { start, bodyStart, end };
}

function setKey(text, header, key, value) {
  const { bodyStart, end } = bounds(text, header);
  const body = text.slice(bodyStart, end);
  const line = `${key} = ${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${key}\\s*=.*$`, "m");
  const updated = pattern.test(body) ? body.replace(pattern, line) : `${line}\n${body}`;
  return text.slice(0, bodyStart) + updated + text.slice(end);
}

function removeKey(text, header, key) {
  const { bodyStart, end } = bounds(text, header);
  const body = text.slice(bodyStart, end);
  const pattern = new RegExp(`^${key}\\s*=.*\\n?`, "m");
  return text.slice(0, bodyStart) + body.replace(pattern, "") + text.slice(end);
}

function setTableKey(text, header, key, value) {
  return setKey(text, header, key, value);
}

function ensureHyperdrive(text) {
  const header = "[[env.staging.hyperdrive]]";
  if (!text.includes(`${header}\n`)) {
    return `${text.trimEnd()}\n\n${header}\nbinding = "HYPERDRIVE"\nid = ${JSON.stringify(process.env.HYPERDRIVE_ID)}\n`;
  }
  let updated = setTableKey(text, header, "binding", "HYPERDRIVE");
  updated = setTableKey(updated, header, "id", process.env.HYPERDRIVE_ID);
  return updated;
}

function ensureIdentityStaging(text) {
  if (!text.includes("[env.staging]\n")) {
    text = `${text.trimEnd()}\n\n[env.staging]\nname = "market-runs-identity-staging"\n\n[env.staging.vars]\nIDENTITY_ENV = "staging"\n`;
  }
  text = setKey(text, "[env.staging]", "name", "market-runs-identity-staging");
  text = setKey(text, "[env.staging.vars]", "IDENTITY_ENV", "staging");
  text = setKey(text, "[env.staging.vars]", "FACE_VERIFIER", process.env.FACE_VERIFIER);
  const hybridKeys = [
    "SMILEID_ENV",
    "SMILEID_CALLBACK_URL",
    "SMILEID_PRIVACY_NOTICE_URL",
    "BIOMETRICS_SERVICE_URL",
  ];
  if (process.env.FACE_VERIFIER === "hybrid") {
    for (const key of hybridKeys) text = setKey(text, "[env.staging.vars]", key, process.env[key]);
    text = setKey(text, "[env.staging.vars]", "EDGE_URL", process.env.EDGE_PUBLIC_URL);
    const header = "[[env.staging.r2_buckets]]";
    if (!text.includes(`${header}\n`)) {
      text = `${text.trimEnd()}\n\n${header}\nbinding = "IDENTITY_CAPTURES"\nbucket_name = "market-runs-identity-captures-staging"\n`;
    } else {
      text = setTableKey(text, header, "binding", "IDENTITY_CAPTURES");
      text = setTableKey(text, header, "bucket_name", "market-runs-identity-captures-staging");
    }
  } else {
    for (const key of [...hybridKeys, "EDGE_URL"]) text = removeKey(text, "[env.staging.vars]", key);
  }
  return text;
}

function apply() {
  let edge = files.edge.text;
  edge = setKey(edge, "[env.staging.vars]", "EDGE_ENV", "staging");
  edge = setKey(edge, "[env.staging.vars]", "OPS_BASE_URL", process.env.EDGE_PUBLIC_URL);
  edge = setKey(edge, "[env.staging.vars]", "OPS_ARCHIVE_URL", process.env.ARCHIVE_PUBLIC_URL);
  edge = setKey(edge, "[env.staging.vars]", "IDENTITY_URL", process.env.IDENTITY_PUBLIC_URL);
  edge = setKey(edge, "[env.staging.vars]", "PAYMENTS_URL", process.env.PAYMENTS_PUBLIC_URL);
  edge = setKey(edge, "[env.staging.vars]", "NOTIFICATIONS_URL", process.env.NOTIFICATIONS_PUBLIC_URL);
  edge = setKey(edge, "[env.staging.vars]", "PAYMENTS_REQUIRED", process.env.PAYMENT_DISPATCHER === "flutterwave" ? "true" : "false");
  edge = removeKey(edge, "[env.staging.vars]", "OSRM_BASE_URL");
  edge = setTableKey(edge, "[[env.staging.kv_namespaces]]", "binding", "MARKET_CONFIG");
  edge = setTableKey(edge, "[[env.staging.kv_namespaces]]", "id", process.env.MARKET_CONFIG_KV_ID);
  files.edge.text = ensureHyperdrive(edge);

  files.archive.text = ensureHyperdrive(files.archive.text);
  files.identity.text = ensureHyperdrive(ensureIdentityStaging(files.identity.text));
  files.payments.text = ensureHyperdrive(setKey(
    files.payments.text,
    "[env.staging.vars]",
    "PAYMENT_DISPATCHER",
    process.env.PAYMENT_DISPATCHER,
  ));
  let notifications = setKey(files.notifications.text, "[env.staging.vars]", "EDGE_URL", process.env.EDGE_PUBLIC_URL);
  notifications = setKey(notifications, "[env.staging.vars]", "RESEND_FROM_EMAIL", process.env.RESEND_FROM_EMAIL);
  files.notifications.text = ensureHyperdrive(notifications);

  for (const file of Object.values(files)) {
    const temporary = `${file.path}.staging-tmp-${process.pid}`;
    fs.writeFileSync(temporary, file.text, { mode: 0o644 });
    fs.renameSync(temporary, file.path);
  }
  console.log("Applied public staging values to five Wrangler configs.");
}

function stagingText(text) {
  const match = /^\[env\.staging\]$/m.exec(text);
  if (!match) return "";
  const arrayMatch = /^\[\[env\.staging\./m.exec(text);
  const starts = [match.index, arrayMatch?.index ?? text.length].filter((index) => index >= 0);
  const start = Math.min(...starts);
  return text.slice(start);
}

function expectKey(text, header, key, expected, failures) {
  try {
    const { bodyStart, end } = bounds(text, header);
    const body = text.slice(bodyStart, end);
    const match = new RegExp(`^${key}\\s*=\\s*"([^"]*)"\\s*$`, "m").exec(body);
    if (!match || match[1] !== expected) failures.push(`${header} ${key} is missing or stale`);
  } catch (error) {
    failures.push(error.message);
  }
}

function check() {
  const failures = [];
  for (const [name, file] of Object.entries(files)) {
    const staging = stagingText(file.text);
    if (!staging) failures.push(`${name}: no staging environment`);
    if (/example\.com|set-with-wrangler/.test(staging)) failures.push(`${name}: staging placeholder remains`);
    if (!staging.includes("[[env.staging.hyperdrive]]")) failures.push(`${name}: Hyperdrive binding missing`);
    else {
      expectKey(file.text, "[[env.staging.hyperdrive]]", "binding", "HYPERDRIVE", failures);
      expectKey(file.text, "[[env.staging.hyperdrive]]", "id", process.env.HYPERDRIVE_ID, failures);
    }
    if (/ALLOW_HEADER_AUTH\s*=\s*"true"/.test(staging)) failures.push(`${name}: deployed header auth is forbidden`);
  }

  expectKey(files.edge.text, "[env.staging.vars]", "OPS_BASE_URL", process.env.EDGE_PUBLIC_URL, failures);
  expectKey(files.edge.text, "[env.staging.vars]", "OPS_ARCHIVE_URL", process.env.ARCHIVE_PUBLIC_URL, failures);
  expectKey(files.edge.text, "[env.staging.vars]", "IDENTITY_URL", process.env.IDENTITY_PUBLIC_URL, failures);
  expectKey(files.edge.text, "[env.staging.vars]", "PAYMENTS_URL", process.env.PAYMENTS_PUBLIC_URL, failures);
  expectKey(files.edge.text, "[env.staging.vars]", "NOTIFICATIONS_URL", process.env.NOTIFICATIONS_PUBLIC_URL, failures);
  expectKey(files.edge.text, "[env.staging.vars]", "PAYMENTS_REQUIRED", process.env.PAYMENT_DISPATCHER === "flutterwave" ? "true" : "false", failures);
  expectKey(files.edge.text, "[[env.staging.kv_namespaces]]", "id", process.env.MARKET_CONFIG_KV_ID, failures);
  if (/^OSRM_BASE_URL\s*=/m.test(stagingText(files.edge.text))) failures.push("edge: OSRM must remain out of this staging batch");

  expectKey(files.identity.text, "[env.staging.vars]", "IDENTITY_ENV", "staging", failures);
  expectKey(files.identity.text, "[env.staging.vars]", "FACE_VERIFIER", process.env.FACE_VERIFIER, failures);
  if (process.env.FACE_VERIFIER === "hybrid") {
    expectKey(files.identity.text, "[env.staging.vars]", "SMILEID_ENV", "sandbox", failures);
    expectKey(files.identity.text, "[env.staging.vars]", "SMILEID_CALLBACK_URL", process.env.SMILEID_CALLBACK_URL, failures);
    expectKey(files.identity.text, "[env.staging.vars]", "SMILEID_PRIVACY_NOTICE_URL", process.env.SMILEID_PRIVACY_NOTICE_URL, failures);
    expectKey(files.identity.text, "[env.staging.vars]", "BIOMETRICS_SERVICE_URL", process.env.BIOMETRICS_SERVICE_URL, failures);
    expectKey(files.identity.text, "[env.staging.vars]", "EDGE_URL", process.env.EDGE_PUBLIC_URL, failures);
    expectKey(files.identity.text, "[[env.staging.r2_buckets]]", "binding", "IDENTITY_CAPTURES", failures);
    expectKey(files.identity.text, "[[env.staging.r2_buckets]]", "bucket_name", "market-runs-identity-captures-staging", failures);
  } else {
    const identityVars = stagingText(files.identity.text);
    for (const key of ["SMILEID_ENV", "SMILEID_CALLBACK_URL", "SMILEID_PRIVACY_NOTICE_URL", "BIOMETRICS_SERVICE_URL", "EDGE_URL"]) {
      if (new RegExp(`^${key}\\s*=`, "m").test(identityVars)) failures.push(`identity: ${key} must be unset in stub mode`);
    }
  }
  expectKey(files.payments.text, "[env.staging.vars]", "PAYMENT_DISPATCHER", process.env.PAYMENT_DISPATCHER, failures);
  expectKey(files.notifications.text, "[env.staging.vars]", "EDGE_URL", process.env.EDGE_PUBLIC_URL, failures);
  expectKey(files.notifications.text, "[env.staging.vars]", "RESEND_FROM_EMAIL", process.env.RESEND_FROM_EMAIL, failures);

  if (failures.length) {
    for (const failure of failures) console.error(`FAIL config: ${failure}`);
    process.exit(1);
  }
  console.log("PASS config: public staging values, bindings, and disabled dev fallbacks");
}

if (mode === "apply") apply();
else check();
