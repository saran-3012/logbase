#!/usr/bin/env bash
#
# Logbase — local development launcher.
#
#   ./scripts/dev.sh              start on a local SQLite file (safe default)
#   ./scripts/dev.sh --watch      restart on file changes (nodemon)
#   ./scripts/dev.sh --fresh      delete the local database first
#   ./scripts/dev.sh --port 4000  use a different HTTP port
#   ./scripts/dev.sh --turso      use .env as-is (⚠ hits the CLOUD database)
#   ./scripts/dev.sh --help
#
# Why a separate env file:
#   src/server.js loads .env via dotenv, and .env points at cloud Turso. dotenv
#   never overwrites variables that are already set, so whatever this script
#   exports wins. That keeps local runs off the production database without
#   editing .env.
#
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
cd "$ROOT"

LOCAL_ENV="$ROOT/.env.local"
LOCAL_DB_FILE="$ROOT/data/local.db"

# ── Arguments ─────────────────────────────────────────────────────────────────
WATCH=0
FRESH=0
USE_TURSO=0
PORT_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --watch|-w) WATCH=1; shift ;;
    --fresh|-f) FRESH=1; shift ;;
    --turso)    USE_TURSO=1; shift ;;
    --port|-p)  PORT_OVERRIDE="${2:-}"; [ -n "$PORT_OVERRIDE" ] || die "--port needs a value"; shift 2 ;;
    --help|-h)  sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1  (try --help)" ;;
  esac
done

# Reject conflicting flags before any side effect (install, warning, sleep).
if [ "$FRESH" -eq 1 ] && [ "$USE_TURSO" -eq 1 ]; then
  die "--fresh cannot be combined with --turso. Wiping the cloud database must be deliberate:  npm run db:reset -- --turso"
fi

header "local"

# ── 1. Toolchain + dependencies ───────────────────────────────────────────────
require_node
ensure_deps

if [ "$WATCH" -eq 1 ] && [ ! -x node_modules/.bin/nodemon ]; then
  info "Installing nodemon (dev dependency)…"
  npm install --no-save nodemon >/dev/null
fi

# ── 2. Environment ────────────────────────────────────────────────────────────
if [ "$USE_TURSO" -eq 1 ]; then
  [ -f .env ] || die "--turso needs a .env file"
  warn "${B}Using .env — this reads and writes the CLOUD database.${N}"
  warn "Migrations run on boot and are destructive. Ctrl-C now if unsure."
  sleep 3
else
  if [ ! -f "$LOCAL_ENV" ]; then
    info "No .env.local found — running setup…"
    "$ROOT/scripts/setup.sh" >/dev/null
    ok "Created .env.local (new JWT_SECRET generated)"
  else
    ok "Using existing .env.local"
  fi
  load_env_file "$LOCAL_ENV"
fi

[ -n "$PORT_OVERRIDE" ] && export PORT="$PORT_OVERRIDE"
mkdir -p "$ROOT/data"

# ── 3. Optional reset ─────────────────────────────────────────────────────────
if [ "$FRESH" -eq 1 ]; then
  rm -f "$LOCAL_DB_FILE" "$LOCAL_DB_FILE"-shm "$LOCAL_DB_FILE"-wal
  ok "Local database deleted — a new schema will be created on boot"
fi

# ── 4. Port availability ──────────────────────────────────────────────────────
PORT="${PORT:-3000}"
require_free_tcp_port "$PORT"

# ── 5. Summary ────────────────────────────────────────────────────────────────
printf '\n'
printf '  %s  %s\n' "Dashboard" "${C}http://localhost:${PORT}${N}"
printf '  %s  %s\n' "Health   " "${DIM}http://localhost:${PORT}/healthz${N}"
printf '  %s  %s\n' "Database " "$(db_label "${TURSO_DATABASE_URL:-<unset>}")"
printf '  %s  %s\n' "UDP ports" "${DIM}${UDP_PORT_RANGE:-10000-10010} (bind ${UDP_BIND_HOST:-0.0.0.0})${N}"
printf '  %s  %s\n' "Mode     " "${DIM}$([ "$WATCH" -eq 1 ] && echo 'watch (restarts on change)' || echo 'normal')${N}"
printf '\n%s\n\n' "${DIM}Ctrl-C to stop${N}"

# ── 6. Start ──────────────────────────────────────────────────────────────────
# exec so Ctrl-C reaches Node directly and its SIGINT handler can release the
# UDP sockets cleanly.
if [ "$WATCH" -eq 1 ]; then
  exec node_modules/.bin/nodemon --quiet --watch src --watch public src/server.js
else
  exec node src/server.js
fi
