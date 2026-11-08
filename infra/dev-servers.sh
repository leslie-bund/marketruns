#!/bin/bash
# Start the local dev environment (edge + archive + identity + payments + notifications + status check).
# Usage: infra/dev-servers.sh [--stop]
set -u
cd "$(dirname "$0")/.."
PIDFILE=.dev-logs/dev-server.pids
BIOMETRICS_STARTED_FILE=.dev-logs/biometrics.started
BIOMETRICS_STARTED=0
mkdir -p .dev-logs

# Wrangler reads infra/.dev.vars itself. Load only the orchestration switches
# here, without printing credentials; explicitly exported shell values win.
if [ -f infra/.dev.vars ]; then
  while IFS= read -r -d '' assignment; do
    export "$assignment"
  done < <(node --input-type=module -e '
    import { loadDevVars } from "./infra/dev-vars.mjs";
    loadDevVars();
    for (const key of ["FACE_VERIFIER", "PAYMENT_DISPATCHER", "PAYMENTS_REQUIRED", "BIOMETRIC_MODEL_DIR", "BIOMETRICS_SERVICE_TOKEN"]) {
      const value = process.env[key];
      if (value !== undefined) process.stdout.write(`${key}=${value}\0`);
    }
  ')
fi

stop_biometrics() {
  if [ -f "$BIOMETRICS_STARTED_FILE" ]; then
    local container_id=""
    read -r container_id < "$BIOMETRICS_STARTED_FILE" || true
    if [ -n "$container_id" ]; then docker stop "$container_id" >/dev/null 2>&1 || true; fi
    rm -f "$BIOMETRICS_STARTED_FILE"
  fi
}

start_biometrics() {
  local model
  for model in w600k_r50.onnx MiniFASNetV2.onnx; do
    if [ ! -f "apps/biometrics/models/$model" ]; then
      echo "missing Docker biometrics model: apps/biometrics/models/$model" >&2
      return 1
    fi
  done
  if [ -z "${BIOMETRICS_SERVICE_TOKEN:-}" ]; then
    echo "FACE_VERIFIER=$FACE_VERIFIER requires BIOMETRICS_SERVICE_TOKEN; no stub fallback is allowed" >&2
    return 1
  fi
  if [ "${#BIOMETRICS_SERVICE_TOKEN}" -lt 32 ]; then
    echo "BIOMETRICS_SERVICE_TOKEN must contain at least 32 characters" >&2
    return 1
  fi
  if curl -s -m 2 http://127.0.0.1:8792/healthz | grep -q ok; then
    echo "biometrics ready (reusing existing loopback service; it will not be stopped)"
    return 0
  fi
  if docker compose --project-name market-runs-local-biometrics -f apps/biometrics/docker-compose.yml ps --status running --services 2>/dev/null | grep -qx biometrics; then
    echo "an existing biometrics container is unhealthy; leaving it untouched" >&2
    return 1
  fi
  wait_port_free 8792 || return 1
  if ! docker compose --project-name market-runs-local-biometrics -f apps/biometrics/docker-compose.yml up -d --build biometrics; then
    # up may have started a previously stopped/new container before failing.
    docker compose --project-name market-runs-local-biometrics -f apps/biometrics/docker-compose.yml stop biometrics >/dev/null 2>&1 || true
    echo "failed to build/start local biometrics" >&2
    return 1
  fi
  local container_id
  container_id="$(docker compose --project-name market-runs-local-biometrics -f apps/biometrics/docker-compose.yml ps -q biometrics)"
  if [ -z "$container_id" ]; then
    docker compose --project-name market-runs-local-biometrics -f apps/biometrics/docker-compose.yml stop biometrics >/dev/null 2>&1 || true
    echo "local biometrics started without a discoverable container id" >&2
    return 1
  fi
  printf '%s\n' "$container_id" > "$BIOMETRICS_STARTED_FILE"
  BIOMETRICS_STARTED=1
  wait_http http://127.0.0.1:8792 || return 1
  echo "biometrics ready on loopback :8792"
}

if [ "${1:-}" = "--stop" ]; then
  if [ -f "$PIDFILE" ]; then
    while read -r pid; do kill -9 "$pid" 2>/dev/null; done < "$PIDFILE"
    rm -f "$PIDFILE"
  fi
  pkill -9 -f "wrangler dev --config infra" 2>/dev/null
  # Orphaned wrangler CLIs (parent = launchd) respawn workerd and keep
  # serving STALE code on the port — sweep them and their runtimes.
  for p in $(pgrep -f "cloudflare-wrangler" 2>/dev/null); do
    par=$(ps -p "$p" -o ppid= 2>/dev/null | tr -d ' ')
    [ "$par" = "1" ] && kill -9 "$p" 2>/dev/null
  done
  sleep 1; pkill -9 -x workerd 2>/dev/null; pkill -9 -f "workerd-darwin-arm64" 2>/dev/null
  stop_biometrics
  sleep 2
  echo "stopped"
  exit 0
fi

cleanup_failed_start() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$BIOMETRICS_STARTED" = 1 ]; then stop_biometrics; fi
  exit "$status"
}
trap cleanup_failed_start EXIT
: > "$PIDFILE"

wait_port_free() {
  for _ in $(seq 1 15); do
    if ! lsof -nP -i ":$1" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "port $1 did not free" >&2; return 1
}

wait_http() {
  for _ in $(seq 1 45); do
    if curl -s -m 2 "$1/healthz" | grep -q ok; then return 0; fi
    sleep 2
  done
  echo "$1 did not become ready" >&2; return 1
}

wait_port_free 8787
# OPS_TOKEN (optional env) guards the ops console API — mandatory whenever the
# edge is reachable beyond localhost (see dev-all.sh --tunnel). Passed as a
# wrangler dev var; unset keeps the dev-open console behavior.
# The local demo explicitly enables header auth and the direct Postgres adapter.
# PAYMENTS_REQUIRED is always explicit so test:stack can override a real local
# .dev.vars with unpaid mode for its temporary rehearsal only.
if [ -n "${OPS_TOKEN:-}" ]; then
  nohup npx wrangler dev --config infra/wrangler.edge.toml --port 8787 \
    --var OPS_TOKEN:"${OPS_TOKEN}" \
    --var DATABASE_URL:"${DATABASE_URL:-postgres://postgres:postgres@localhost:54322/market_runs}" \
    --var ALLOW_HEADER_AUTH:true \
    --var OPS_LEGACY_DEV:true \
    --var OPS_LOCAL_DEV:true \
    --var PAYMENTS_REQUIRED:"${PAYMENTS_REQUIRED-}" \
    --var PAYMENTS_INTERNAL_TOKEN:"${PAYMENTS_INTERNAL_TOKEN:-market-runs-dev-payments-internal}" \
    --var NOTIFICATION_INTERNAL_TOKEN:"${NOTIFICATION_INTERNAL_TOKEN:-market-runs-dev-notification-internal}" \
    > .dev-logs/edge.log 2>&1 &
else
  nohup npx wrangler dev --config infra/wrangler.edge.toml --port 8787 \
    --var DATABASE_URL:"${DATABASE_URL:-postgres://postgres:postgres@localhost:54322/market_runs}" \
    --var ALLOW_HEADER_AUTH:true \
    --var OPS_LEGACY_DEV:true \
    --var OPS_LOCAL_DEV:true \
    --var PAYMENTS_REQUIRED:"${PAYMENTS_REQUIRED-}" \
    --var PAYMENTS_INTERNAL_TOKEN:"${PAYMENTS_INTERNAL_TOKEN:-market-runs-dev-payments-internal}" \
    --var NOTIFICATION_INTERNAL_TOKEN:"${NOTIFICATION_INTERNAL_TOKEN:-market-runs-dev-notification-internal}" \
    > .dev-logs/edge.log 2>&1 &
fi
echo $! >> "$PIDFILE"
wait_http http://localhost:8787 || exit 1
echo "edge ready"

wait_port_free 8788
# --var before the redirect, same shape as every line here: the pnpm-shimmed
# wrangler mangles --var argv ordering otherwise (both values arrive in-env).
nohup npx wrangler dev --config infra/wrangler.archive.toml --port 8788 \
  --var DATABASE_URL:"${DATABASE_URL:-postgres://postgres:postgres@localhost:54322/market_runs}" \
  > .dev-logs/archive.log 2>&1 &
echo $! >> "$PIDFILE"
wait_http http://localhost:8788 || exit 1
echo "archive ready"

if [ "${FACE_VERIFIER:-}" = "hybrid" ] || [ "${FACE_VERIFIER:-}" = "smileid" ]; then
  start_biometrics || exit 1
fi

wait_port_free 8789
if [ -n "${FACE_VERIFIER:-}" ]; then
  nohup npx wrangler dev --config infra/wrangler.identity.toml --port 8789 \
    --var DATABASE_URL:"${DATABASE_URL:-postgres://postgres:postgres@localhost:54322/market_runs}" \
    --var "FACE_VERIFIER:${FACE_VERIFIER}" \
    > .dev-logs/identity.log 2>&1 &
else
  nohup npx wrangler dev --config infra/wrangler.identity.toml --port 8789 \
    --var DATABASE_URL:"${DATABASE_URL:-postgres://postgres:postgres@localhost:54322/market_runs}" \
    > .dev-logs/identity.log 2>&1 &
fi
echo $! >> "$PIDFILE"
wait_http http://localhost:8789 || exit 1
echo "identity ready"

wait_port_free 8790
if [ -n "${PAYMENT_DISPATCHER:-}" ]; then
  nohup npx wrangler dev --config infra/wrangler.payments.toml --port 8790 \
    --var DATABASE_URL:"${DATABASE_URL:-postgres://postgres:postgres@localhost:54322/market_runs}" \
    --var ALLOW_HEADER_AUTH:true \
    --var PAYMENTS_INTERNAL_TOKEN:"${PAYMENTS_INTERNAL_TOKEN:-market-runs-dev-payments-internal}" \
    --var "PAYMENT_DISPATCHER:${PAYMENT_DISPATCHER}" \
    > .dev-logs/payments.log 2>&1 &
else
  # Bash 3.2 treats an empty array expansion as unset under `set -u`.
  nohup npx wrangler dev --config infra/wrangler.payments.toml --port 8790 \
    --var DATABASE_URL:"${DATABASE_URL:-postgres://postgres:postgres@localhost:54322/market_runs}" \
    --var ALLOW_HEADER_AUTH:true \
    --var PAYMENTS_INTERNAL_TOKEN:"${PAYMENTS_INTERNAL_TOKEN:-market-runs-dev-payments-internal}" \
    > .dev-logs/payments.log 2>&1 &
fi
echo $! >> "$PIDFILE"
wait_http http://localhost:8790 || exit 1
echo "payments ready"

wait_port_free 8791
nohup npx wrangler dev --config infra/wrangler.notifications.toml --port 8791 \
  --var DATABASE_URL:"${DATABASE_URL:-postgres://postgres:postgres@localhost:54322/market_runs}" \
  --var NOTIFICATION_INTERNAL_TOKEN:"${NOTIFICATION_INTERNAL_TOKEN:-market-runs-dev-notification-internal}" \
  > .dev-logs/notifications.log 2>&1 &
echo $! >> "$PIDFILE"
wait_http http://localhost:8791 || exit 1
echo "notifications ready"
echo "console: http://localhost:8787/ops"
