#!/bin/bash
# Start the local dev environment (edge + archive + identity + payments + status check).
# Usage: infra/dev-servers.sh [--stop]
set -u
cd "$(dirname "$0")/.."
PIDFILE=.dev-logs/dev-server.pids

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
  sleep 2
  echo "stopped"
  exit 0
fi

mkdir -p .dev-logs
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
if [ -n "${OPS_TOKEN:-}" ]; then
  nohup npx wrangler dev --config infra/wrangler.edge.toml --port 8787 \
    --var OPS_TOKEN:"${OPS_TOKEN}" \
    > .dev-logs/edge.log 2>&1 &
else
  nohup npx wrangler dev --config infra/wrangler.edge.toml --port 8787 \
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

wait_port_free 8789
nohup npx wrangler dev --config infra/wrangler.identity.toml --port 8789 \
  --var DATABASE_URL:"${DATABASE_URL:-postgres://postgres:postgres@localhost:54322/market_runs}" \
  > .dev-logs/identity.log 2>&1 &
echo $! >> "$PIDFILE"
wait_http http://localhost:8789 || exit 1
echo "identity ready"

wait_port_free 8790
nohup npx wrangler dev --config infra/wrangler.payments.toml --port 8790 \
  --var DATABASE_URL:"${DATABASE_URL:-postgres://postgres:postgres@localhost:54322/market_runs}" \
  > .dev-logs/payments.log 2>&1 &
echo $! >> "$PIDFILE"
wait_http http://localhost:8790 || exit 1
echo "payments ready"
echo "console: http://localhost:8787/ops"
