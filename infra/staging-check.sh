#!/usr/bin/env bash
# Non-mutating staging go/no-go. Secrets are used only for authenticated checks.

set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="${STAGING_ENV_FILE:-$ROOT/infra/.staging/.dev.vars}"
ALLOW_STUB=0
SKIP_LIVE=0
FAILURES=0

for arg in "$@"; do
  case "$arg" in
    --allow-stub) ALLOW_STUB=1 ;;
    --skip-live) SKIP_LIVE=1 ;;
    --help|-h)
      printf 'Usage: bash infra/staging-check.sh [--allow-stub] [--skip-live]\n'
      printf 'Default: strict paid Flutterwave + hybrid identity go/no-go.\n'
      printf '%s\n' '--allow-stub: infrastructure-only result, never paid/hybrid rehearsal approval.'
      printf '%s\n' '--skip-live: omit deployed HTTP checks only; config/resource/secret checks remain.'
      exit 0
      ;;
    *) printf 'Unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }
check() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then pass "$label"; else fail "$label"; fi
}

for command_name in node npx curl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required CLI: %s\n' "$command_name" >&2
    exit 2
  fi
done
if [[ ! -f "$ENV_FILE" ]]; then
  printf 'Missing staging state: %s (run infra/staging-setup.sh)\n' "$ENV_FILE" >&2
  exit 2
fi

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

REQUIRED_STATE=(
  LAUNCH_MARKET EDGE_PUBLIC_URL OPS_DASHBOARD_URL ARCHIVE_PUBLIC_URL IDENTITY_PUBLIC_URL
  PAYMENTS_PUBLIC_URL NOTIFICATIONS_PUBLIC_URL RESEND_FROM_EMAIL
  DATABASE_URL HYPERDRIVE_ID PAYMENT_DISPATCHER FACE_VERIFIER
  OPS_AUTH_SECRET ID_DOCUMENT_HMAC_SECRET ARCHIVE_INTERNAL_TOKEN
  NOTIFICATION_INTERNAL_TOKEN PAYMENTS_INTERNAL_TOKEN IDENTITY_SESSION_SECRET
  IDENTITY_INTERNAL_TOKEN IDENTITY_ENCRYPTION_KEY FLUTTERWAVE_SECRET_KEY
  FLUTTERWAVE_WEBHOOK_SECRET_HASH RESEND_API_KEY
)
if [[ "${FACE_VERIFIER:-}" == hybrid ]]; then
  REQUIRED_STATE+=(
    SMILEID_ENV SMILEID_CALLBACK_URL SMILEID_PRIVACY_NOTICE_URL
    BIOMETRICS_SERVICE_URL SMILEID_PARTNER_ID SMILEID_API_KEY BIOMETRICS_SERVICE_TOKEN
  )
fi
if [[ "${PAYMENT_DISPATCHER:-}" == flutterwave ]]; then
  REQUIRED_STATE+=(FLUTTERWAVE_PUBLIC_KEY GOOGLE_MAPS_API_KEY RECONCILE_PROVIDER_SINCE)
fi
for name in "${REQUIRED_STATE[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    fail "staging state has $name"
    printf -v "$name" '%s' ""
  fi
done
if [[ "$FAILURES" -gt 0 ]]; then
  printf 'NO-GO: complete the staging state with infra/staging-setup.sh.\n' >&2
  exit 2
fi
if [[ "$ALLOW_STUB" -eq 1 ]]; then
  printf 'INFO infrastructure-only mode: this result never approves a real paid/hybrid rehearsal.\n'
else
  if [[ "$PAYMENT_DISPATCHER" != flutterwave ]]; then
    fail "paid Flutterwave posture (use --allow-stub only for an infrastructure-only check)"
  fi
  if [[ "$FACE_VERIFIER" != hybrid ]]; then
    fail "hybrid identity posture (use --allow-stub only for an infrastructure-only check)"
  fi
fi
if [[ "$PAYMENT_DISPATCHER" != flutterwave && "$PAYMENT_DISPATCHER" != stub ]]; then
  fail "PAYMENT_DISPATCHER is flutterwave or stub"
fi
if [[ "$FACE_VERIFIER" != hybrid && "$FACE_VERIFIER" != stub ]]; then
  fail "FACE_VERIFIER is hybrid or stub"
fi
if [[ "$PAYMENT_DISPATCHER" == flutterwave && "$FLUTTERWAVE_SECRET_KEY" != FLWSECK_TEST-* ]]; then
  fail "Flutterwave staging key is not explicitly a test key"
fi
if [[ "$PAYMENT_DISPATCHER" == flutterwave && "$FLUTTERWAVE_PUBLIC_KEY" != FLWPUBK_TEST-* ]]; then
  fail "Flutterwave mobile key is not explicitly a test key"
fi
if [[ "$FACE_VERIFIER" == hybrid ]]; then
  [[ "$SMILEID_ENV" == sandbox ]] || fail "Smile ID staging environment is sandbox"
  [[ ${#BIOMETRICS_SERVICE_TOKEN} -ge 32 ]] || fail "biometrics service token has at least 32 characters"
fi
check "distinct Worker and dedicated ops dashboard origins" node -e '
  const origins = process.argv.slice(1).map((value) => new URL(value).origin);
  process.exit(new Set(origins).size === origins.length ? 0 : 1);
' "$EDGE_PUBLIC_URL" "$OPS_DASHBOARD_URL" "$ARCHIVE_PUBLIC_URL" "$IDENTITY_PUBLIC_URL" "$PAYMENTS_PUBLIC_URL" "$NOTIFICATIONS_PUBLIC_URL"

cd "$ROOT" || exit 2
if node infra/staging-toml.mjs check; then :; else FAILURES=$((FAILURES + 1)); fi
check "Cloudflare authentication" npx wrangler whoami

QUEUES=(
  archive-snapshots-staging archive-snapshots-dlq-staging
  payment-dispatch-staging payment-dispatch-dlq-staging
  notification-events-staging notification-events-dlq-staging
)
for queue in "${QUEUES[@]}"; do
  check "queue $queue" npx wrangler queues info "$queue"
done
check "R2 market-runs-archive-staging" npx wrangler r2 bucket info market-runs-archive-staging
if [[ "$FACE_VERIFIER" == hybrid ]]; then
  check "private R2 market-runs-identity-captures-staging" npx wrangler r2 bucket info market-runs-identity-captures-staging
fi

list_contains() {
  local expected="$1"
  shift
  local output
  output=$("$@" 2>/dev/null) || return 1
  [[ "$output" == *"$expected"* ]]
}
check "Hyperdrive $HYPERDRIVE_ID" list_contains "$HYPERDRIVE_ID" npx wrangler hyperdrive list

secret_present() {
  local worker="$1" secret="$2" output
  output=$(npx wrangler secret list --config "infra/wrangler.$worker.toml" --env staging --format json 2>/dev/null) || return 1
  printf '%s' "$output" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      try {
        const secrets = JSON.parse(input);
        process.exit(Array.isArray(secrets) && secrets.some((item) => item.name === process.argv[1]) ? 0 : 1);
      } catch { process.exit(1); }
    });
  ' "$secret"
}

SECRET_MATRIX=(
  edge:OPS_AUTH_SECRET edge:ID_DOCUMENT_HMAC_SECRET edge:ARCHIVE_INTERNAL_TOKEN
  edge:NOTIFICATION_INTERNAL_TOKEN edge:PAYMENTS_INTERNAL_TOKEN
  edge:IDENTITY_SESSION_SECRET edge:IDENTITY_INTERNAL_TOKEN edge:RESEND_API_KEY
  archive:ARCHIVE_INTERNAL_TOKEN
  identity:IDENTITY_ENCRYPTION_KEY identity:IDENTITY_SESSION_SECRET identity:IDENTITY_INTERNAL_TOKEN
  payments:PAYMENTS_INTERNAL_TOKEN payments:FLUTTERWAVE_SECRET_KEY payments:FLUTTERWAVE_WEBHOOK_SECRET_HASH
  notifications:NOTIFICATION_INTERNAL_TOKEN notifications:RESEND_API_KEY
)
if [[ "$FACE_VERIFIER" == hybrid ]]; then
  SECRET_MATRIX+=(
    identity:SMILEID_PARTNER_ID identity:SMILEID_API_KEY identity:BIOMETRICS_SERVICE_TOKEN
  )
fi
for pair in "${SECRET_MATRIX[@]}"; do
  worker=${pair%%:*}
  secret=${pair#*:}
  check "$worker secret $secret" secret_present "$worker" "$secret"
done

if node infra/staging-db-check.mjs; then :; else FAILURES=$((FAILURES + 1)); fi

http_ok() {
  curl --fail --silent --show-error --max-time 15 --output /dev/null "$1"
}
http_status_is() {
  local expected="$1" url="$2" status
  shift 2
  status=$(curl --silent --max-time 15 --output /dev/null --write-out '%{http_code}' "$@" "$url") || return 1
  [[ "$status" == "$expected" ]]
}
ops_is_guarded() {
  local status
  status=$(curl --silent --max-time 15 --output /dev/null --write-out '%{http_code}' "$EDGE_PUBLIC_URL/ops/api/overview") || return 1
  [[ "$status" == 401 || "$status" == 403 || "$status" == 302 ]]
}
payments_dispatcher_ok() {
  local body
  body=$(curl --fail --silent --show-error --max-time 15 "$PAYMENTS_PUBLIC_URL/healthz") || return 1
  printf '%s' "$body" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      try { process.exit(JSON.parse(input).dispatcher === process.argv[1] ? 0 : 1); }
      catch { process.exit(1); }
    });
  ' "$PAYMENT_DISPATCHER"
}
biometrics_ok() {
  local body
  body=$(curl --fail --silent --show-error --max-time 15 "$BIOMETRICS_SERVICE_URL/healthz") || return 1
  printf '%s' "$body" | node -e '
    let input = ""; process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      try {
        const health = JSON.parse(input);
        process.exit(health.service === "market-runs-biometrics" && typeof health.modelVersion === "string" && health.modelVersion ? 0 : 1);
      } catch { process.exit(1); }
    });
  '
}

if [[ "$SKIP_LIVE" -eq 0 ]]; then
  check "edge HTTPS health" http_ok "$EDGE_PUBLIC_URL/healthz"
  check "archive HTTPS health" http_ok "$ARCHIVE_PUBLIC_URL/healthz"
  check "archive rejects anonymous internal read" http_status_is 401 "$ARCHIVE_PUBLIC_URL/admin/future-read"
  check "archive rejects invalid internal auth" http_status_is 401 "$ARCHIVE_PUBLIC_URL/admin/future-read" --header "x-archive-internal: definitely-invalid-staging-token"
  check "archive service auth reaches routing" http_status_is 404 "$ARCHIVE_PUBLIC_URL/admin/future-read" --header "x-archive-internal: $ARCHIVE_INTERNAL_TOKEN"
  check "identity HTTPS health" http_ok "$IDENTITY_PUBLIC_URL/healthz"
  check "payments HTTPS health" http_ok "$PAYMENTS_PUBLIC_URL/healthz"
  check "payments active dispatcher" payments_dispatcher_ok
  check "payments rejects anonymous bank directory" http_status_is 401 "$PAYMENTS_PUBLIC_URL/payments/banks"
  check "payments rejects invalid service auth" http_status_is 401 "$PAYMENTS_PUBLIC_URL/payments/banks" --header "x-payments-internal: definitely-invalid-staging-token"
  if [[ "$PAYMENT_DISPATCHER" == flutterwave ]]; then
    check "edge to payments authenticated bank directory" http_ok "$EDGE_PUBLIC_URL/payments/banks"
  fi
  check "notifications HTTPS health" http_ok "$NOTIFICATIONS_PUBLIC_URL/healthz"
  check "dedicated ops dashboard" http_ok "$OPS_DASHBOARD_URL"
  check "embedded ops login remains retired" http_status_is 404 "$EDGE_PUBLIC_URL/ops/login"
  check "ops API rejects anonymous access" ops_is_guarded
  if [[ "$FACE_VERIFIER" == hybrid ]]; then
    check "Smile ID callback rejects missing signature" http_status_is 401 "$EDGE_PUBLIC_URL/callbacks/smileid" \
      --request POST --header "content-type: application/json" --data '{}'
    check "Smile ID callback rejects invalid signature" http_status_is 401 "$EDGE_PUBLIC_URL/callbacks/smileid" \
      --request POST --header "content-type: application/json" --header "Response-Timestamp: invalid-staging-timestamp" \
      --header "Response-Signature: invalid-staging-signature" --data '{}'
    check "published privacy notice HTTPS" http_ok "$SMILEID_PRIVACY_NOTICE_URL"
    check "private biometrics health and model version" biometrics_ok
    check "biometrics rejects invalid bearer auth" http_status_is 401 "$BIOMETRICS_SERVICE_URL/v1/face/embed" \
      --request POST --header "authorization: Bearer definitely-invalid-staging-token" \
      --header "content-type: application/json" --data '{}'
  fi
else
  printf 'SKIP deployed HTTP checks (--skip-live)\n'
fi

REPORT=$(mktemp)
trap 'rm -f "$REPORT"' EXIT
run_reconciliation() {
  if [[ "$PAYMENT_DISPATCHER" == flutterwave ]]; then
    DATABASE_URL="$DATABASE_URL" FLUTTERWAVE_SECRET_KEY="$FLUTTERWAVE_SECRET_KEY" \
      node infra/reconcile.mjs --json --market="$LAUNCH_MARKET" --provider-since="$RECONCILE_PROVIDER_SINCE"
  else
    DATABASE_URL="$DATABASE_URL" FLUTTERWAVE_SECRET_KEY="$FLUTTERWAVE_SECRET_KEY" \
      node infra/reconcile.mjs --json --market="$LAUNCH_MARKET"
  fi
}
if run_reconciliation >"$REPORT" 2>/dev/null; then
  :
else
  fail "reconciliation command"
fi
cat "$REPORT"
if ! node -e '
  const fs = require("node:fs");
  const raw = fs.readFileSync(process.argv[1], "utf8").replace(/\nRECONCILE_EXIT=\d+\s*$/, "");
  const report = JSON.parse(raw);
  const bad = report.checks.filter((check) => ["FAIL", "WARN"].includes(check.status));
  const vendorSkipped = report.checks.some((check) => check.name === "vendor" && check.status === "SKIP");
  if (bad.length || (process.argv[2] === "flutterwave" && vendorSkipped)) process.exit(1);
' "$REPORT" "$PAYMENT_DISPATCHER"; then
  fail "reconciliation has FAIL/WARN results or a skipped paid vendor check"
else
  pass "reconciliation has no FAIL/WARN results"
fi

if [[ "$FAILURES" -eq 0 ]]; then
  if [[ "$ALLOW_STUB" -eq 1 ]]; then
    printf '\nGO (infrastructure-only): checks passed; this is not paid/hybrid rehearsal approval.\n'
  elif [[ "$SKIP_LIVE" -eq 1 ]]; then
    printf '\nGO (configuration/resources only): deployed HTTP checks were skipped; this is not live rehearsal approval.\n'
  else
    printf '\nGO: strict paid Flutterwave + hybrid identity staging checks passed.\n'
  fi
  exit 0
fi
printf '\nNO-GO: %s staging check(s) failed. Do not start a paid/hybrid rehearsal.\n' "$FAILURES" >&2
exit 1
