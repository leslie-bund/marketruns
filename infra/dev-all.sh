#!/bin/bash
# dev-all.sh — ONE command for the whole demo stack:
#
#   1. Postgres in docker (starts or reuses the market-runs-postgres container)
#   2. Drizzle migrations against it
#   3. Core market rows (idempotent; required before any store registration)
#   4. Edge (:8787) + archive (:8788) + identity (:8789) + payments (:8790)
#      + notifications (:8791) via infra/dev-servers.sh
#   5. Demo seed (2 Balogun stores + 1 Computer Village store) — idempotent
#   6. Optional Cloudflare quick tunnel so friends' phones can reach the edge
#
# Usage:
#   infra/dev-all.sh [--tunnel] [--seed|--no-seed]
#
# Environment:
#   DATABASE_URL  override the local DSN
#                 (default postgres://postgres:postgres@localhost:54322/market_runs)
#   OPS_TOKEN     guards the ops console API. Optional for local-only dev
#                 (open-console behavior preserved). With --tunnel one is
#                 REQUIRED — a random token is generated when unset — because
#                 requireOps() admits EVERYONE when OPS_TOKEN is empty, and a
#                 tunnel without it exposes market config writes and ops
#                 settlements to the public internet.
#
# Ctrl-C stops everything this script started (tunnel, both dev servers, and
# the Postgres container only if this script started it). Logs: .dev-logs/
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER="market-runs-postgres"
PG_PORT="54322"
export DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@localhost:${PG_PORT}/market_runs}"

# --------------------------------------------------------------------------
# Flags
# --------------------------------------------------------------------------
TUNNEL=0
SEED=1
for arg in "$@"; do
  case "$arg" in
    --tunnel)  TUNNEL=1 ;;
    --seed)    SEED=1 ;;
    --no-seed) SEED=0 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

mkdir -p .dev-logs

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }

# --------------------------------------------------------------------------
# Cleanup — kill only what THIS script started; no orphans.
# dev-servers.sh --stop sweeps the wrangler/workerd pair; the Postgres
# container is stopped only when we were the ones to start it.
# --------------------------------------------------------------------------
TUNNEL_PID=""
PG_STARTED=0
SERVERS_STARTED=0
cleanup() {
  trap - EXIT INT TERM
  echo
  say "shutting down…"
  if [ -n "$TUNNEL_PID" ]; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
    echo "✓ tunnel stopped"
  fi
  if [ "$SERVERS_STARTED" = 1 ]; then
    infra/dev-servers.sh --stop >/dev/null 2>&1 || true
    echo "✓ dev servers stopped (edge + archive + identity + payments + notifications)"
  fi
  if [ "$PG_STARTED" = 1 ]; then
    docker stop "$CONTAINER" >/dev/null 2>&1 || true
    echo "✓ postgres container stopped (data persists in the container)"
  fi
  say "all clean — no orphan processes."
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --------------------------------------------------------------------------
# 1. Postgres
# --------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || { warn "docker not found — install Docker Desktop or colima first."; exit 1; }
docker info >/dev/null 2>&1 || { warn "docker daemon is not running — start Docker Desktop (or colima start)."; exit 1; }

if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "✓ postgres: container $CONTAINER already running"
elif docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  docker start "$CONTAINER" >/dev/null
  PG_STARTED=1
  echo "✓ postgres: restarted existing container $CONTAINER"
else
  docker run -d --name "$CONTAINER" -p "${PG_PORT}:5432" \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=market_runs \
    postgres:16-alpine >/dev/null
  PG_STARTED=1
  echo "✓ postgres: started new container $CONTAINER on :${PG_PORT}"
fi

printf 'waiting for postgres…'
ready=0
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U postgres -d market_runs >/dev/null 2>&1; then ready=1; break; fi
  printf '.'; sleep 1
done
echo
[ "$ready" = 1 ] || { warn "postgres did not become ready in 30s — check: docker logs $CONTAINER"; exit 1; }

# --------------------------------------------------------------------------
# 2. Migrations (system of record — Drizzle, infra/drizzle)
# --------------------------------------------------------------------------
echo "running drizzle migrations…"
if (cd infra/drizzle && npx drizzle-kit migrate) > .dev-logs/migrate.log 2>&1; then
  echo "✓ migrations applied"
else
  warn "migrations FAILED — see .dev-logs/migrate.log"
  exit 1
fi

# --------------------------------------------------------------------------
# 3. Core markets — AFTER migrations and BEFORE demo stores. Idempotent upserts
#    also repair an existing dev DB; coreRegistry.saveStore requires these rows.
# --------------------------------------------------------------------------
node infra/seed-core.mjs

# --------------------------------------------------------------------------
# 4. OPS_TOKEN policy — decided BEFORE the edge starts so dev-servers.sh
#    can pass it through as a wrangler var.
# --------------------------------------------------------------------------
TOKEN_GENERATED=0
if [ "$TUNNEL" = 1 ]; then
  if [ -z "${OPS_TOKEN:-}" ]; then
    if command -v openssl >/dev/null 2>&1; then
      OPS_TOKEN="$(openssl rand -hex 24)"
    else
      OPS_TOKEN="$( (uuidgen; uuidgen) | tr -d '-' | tr 'A-F' 'a-f' )"
    fi
    export OPS_TOKEN
    TOKEN_GENERATED=1
  fi
  if [ "${#OPS_TOKEN}" -lt 16 ]; then
    warn "╔══════════════════════════════════════════════════════════════════╗"
    warn "║  WARNING: tunneling with a SHORT/WEAK OPS_TOKEN.                 ║"
    warn "║  Anyone who guesses it can write market config and settle runs   ║"
    warn "║  through the public tunnel URL. Set a longer OPS_TOKEN (32+).    ║"
    warn "╚══════════════════════════════════════════════════════════════════╝"
  fi
fi

# --------------------------------------------------------------------------
# 5. Edge + archive + identity + payments + notifications (dev-servers.sh owns
#    the wrangler processes, health checks, and the pidfile; it reads OPS_TOKEN
#    from the environment when set and passes DATABASE_URL through to all four
#    Postgres-backed workers).
# --------------------------------------------------------------------------
SERVERS_STARTED=1
infra/dev-servers.sh

# --------------------------------------------------------------------------
# 6. Demo seed (default on; --no-seed skips). Idempotent — safe every run.
# --------------------------------------------------------------------------
if [ "$SEED" = 1 ]; then
  node infra/seed-demo.mjs --edge http://localhost:8787
fi

# --------------------------------------------------------------------------
# 7. Optional Cloudflare quick tunnel → http://localhost:8787
# --------------------------------------------------------------------------
TUNNEL_URL=""
if [ "$TUNNEL" = 1 ]; then
  if command -v cloudflared >/dev/null 2>&1; then
    cloudflared tunnel --url http://localhost:8787 --no-autoupdate \
      > .dev-logs/tunnel.log 2>&1 &
    TUNNEL_PID=$!
    printf 'waiting for tunnel URL…'
    for _ in $(seq 1 30); do
      TUNNEL_URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' .dev-logs/tunnel.log 2>/dev/null | head -n1 || true)"
      [ -n "$TUNNEL_URL" ] && break
      kill -0 "$TUNNEL_PID" 2>/dev/null || break  # cloudflared died early
      printf '.'; sleep 1
    done
    echo
    if [ -z "$TUNNEL_URL" ]; then
      warn "tunnel did not come up — see .dev-logs/tunnel.log — continuing LAN-only."
      kill "$TUNNEL_PID" 2>/dev/null || true
      TUNNEL_PID=""
    else
      echo "✓ tunnel live: $TUNNEL_URL"
    fi
  else
    warn "cloudflared is not installed — continuing LAN-only."
    warn "install it with:  brew install cloudflared   (then re-run with --tunnel)"
  fi
fi

# --------------------------------------------------------------------------
# Summary box — everything the demo needs, in one place.
# --------------------------------------------------------------------------
PUBLIC_URL="${TUNNEL_URL:-http://localhost:8787}"
OPS_URL="${PUBLIC_URL}/ops"
[ -n "${OPS_TOKEN:-}" ] && OPS_URL="${PUBLIC_URL}/ops?token=${OPS_TOKEN}"

echo
say "┌──────────────────────────────────────────────────────────────────────┐"
say "│  MARKET RUNS — DEMO STACK READY                                      │"
say "└──────────────────────────────────────────────────────────────────────┘"
echo "  edge (public URL for phones)   $PUBLIC_URL"
echo "  edge (local)                   http://localhost:8787"
echo "  archive (local)                http://localhost:8788"
echo "  identity (local)               http://localhost:8789"
echo "  payments (local)               http://localhost:8790"
echo "  notifications (local)          http://localhost:8791"
echo "  ops console                    $OPS_URL"
if [ "$TOKEN_GENERATED" = 1 ]; then
  echo "  OPS_TOKEN (generated)          $OPS_TOKEN"
fi
echo
echo "  ── Your phone / friends' phones ─────────────────────────────────────"
echo "  1. Put this line in apps/mobile/.env :"
say "       EXPO_PUBLIC_EDGE_URL=$PUBLIC_URL"
echo "  2. In apps/mobile, start Metro for devices:"
if [ -n "$TUNNEL_URL" ]; then
  echo "       npx expo start --tunnel"
  echo "     (--tunnel needs @expo/ngrok — first run offers to install it,"
  echo "      or: npx pnpm@9.15.4 add -D @expo/ngrok --filter @market-runs/mobile)"
else
  echo "       npx expo start            # same Wi-Fi: set EXPO_PUBLIC_EDGE_URL to this Mac's LAN IP"
  echo "     friends off-LAN need the tunnel: re-run with --tunnel (brew install cloudflared)"
fi
echo "  3. Restart Metro after changing .env — EXPO_PUBLIC_* is baked at bundle time."
if [ "$TUNNEL" = 1 ] && [ "$TOKEN_GENERATED" = 1 ]; then
  echo
  echo "  OPS_TOKEN was generated for this session and passed to the edge —"
  echo "  the ops API is NOT open on the tunnel. Keep the /ops?token= URL private."
fi
echo
say "serving — Ctrl-C stops everything this script started."
while :; do sleep 3600 & wait $!; done
