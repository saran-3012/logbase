#!/usr/bin/env bash
#
# Logbase — end-to-end test. Boots the real server against a throwaway SQLite
# database and exercises the full ingest path, including real UDP datagrams.
#
#   ./scripts/test.sh              boot, test, tear down
#   ./scripts/test.sh --keep       leave the test database behind for inspection
#   ./scripts/test.sh --port 3998  use a different HTTP port
#   ./scripts/test.sh --against http://host:port   test an already-running server
#   ./scripts/test.sh --help
#
# Never touches .env, .env.local or the development database. The suite is
# stateful (it asserts exact counts), so it always starts from an empty file.
#
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
cd "$ROOT"

TEST_PORT=3998
KEEP=0
AGAINST=""
# smoke.js binds UDP collectors on 10001–10005, so the range must cover them.
TEST_UDP_RANGE="10000-10010"
TEST_DB="$ROOT/data/test-$$.db"
SUITE="$ROOT/.github/workflows/smoke.js"

while [ $# -gt 0 ]; do
  case "$1" in
    --keep)     KEEP=1; shift ;;
    --port|-p)  TEST_PORT="${2:-}"; [ -n "$TEST_PORT" ] || die "--port needs a value"; shift 2 ;;
    --against)  AGAINST="${2:-}"; [ -n "$AGAINST" ] || die "--against needs a URL"; shift 2 ;;
    --help|-h)  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1  (try --help)" ;;
  esac
done

header "test"
[ -f "$SUITE" ] || die "Test suite not found: $SUITE"
need_cmd curl

SERVER_PID=""
SUITE_PID=""

cleanup() {
  local code=$?
  # Stop the suite first so it cannot keep writing to a server we are killing.
  if [ -n "$SUITE_PID" ] && kill -0 "$SUITE_PID" 2>/dev/null; then
    kill -TERM "$SUITE_PID" 2>/dev/null || true
  fi
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    # SIGTERM first so the shutdown handler releases the UDP sockets.
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "$SERVER_PID" 2>/dev/null && kill -KILL "$SERVER_PID" 2>/dev/null || true
    info "Server stopped"
  fi
  if [ "$KEEP" -eq 0 ]; then
    rm -f "$TEST_DB" "$TEST_DB"-shm "$TEST_DB"-wal 2>/dev/null || true
  elif [ -f "$TEST_DB" ]; then
    info "Test database kept: $TEST_DB"
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

# ── Against an existing server ────────────────────────────────────────────────
if [ -n "$AGAINST" ]; then
  info "Testing an existing server: $AGAINST"
  curl -sf "$AGAINST/healthz" >/dev/null 2>&1 || die "No healthy server at $AGAINST"
  warn "The suite writes real data into that server's database."
  BASE="$AGAINST" node "$SUITE"
  exit $?
fi

# ── Boot a throwaway server ───────────────────────────────────────────────────
require_node
ensure_deps
mkdir -p "$ROOT/data"

require_free_tcp_port "$TEST_PORT" "--port <n>"

# Fail fast if a stale process still holds a UDP port the suite needs.
for p in 10001 10002 10005; do
  if udp_port_in_use "$p"; then
    owner="$(port_owner "$p")"
    die "UDP port $p is in use${owner:+ (by $owner)} — the suite needs 10001–10005 free"
  fi
done

section "Boot"
info "Port $TEST_PORT · database $(basename "$TEST_DB")"

# A fully explicit environment: nothing is inherited from .env or .env.local,
# so a developer's local configuration can never change the result.
env -i \
  PATH="$PATH" HOME="$HOME" \
  NODE_ENV=test \
  PORT="$TEST_PORT" \
  DB_ADAPTER=libsql \
  TURSO_DATABASE_URL="file:$TEST_DB" \
  TURSO_AUTH_TOKEN="" \
  JWT_SECRET="test-only-secret-$$" \
  JWT_EXPIRES_IN=7d \
  LOG_RETENTION_HOURS=24 \
  INGEST_BODY_LIMIT=10mb \
  MAX_BATCH_SIZE=1000 \
  UDP_ENABLED=true \
  UDP_BIND_HOST=0.0.0.0 \
  UDP_PORT_RANGE="$TEST_UDP_RANGE" \
  UDP_MAX_LISTENERS=1 \
  UDP_QUEUE_SIZE=5000 \
  node src/server.js > /tmp/lb-test-server.log 2>&1 &
SERVER_PID=$!

if ! wait_for_http "http://localhost:$TEST_PORT/healthz" 30; then
  err "Server did not become healthy within 30s. Output:"
  sed 's/^/    /' /tmp/lb-test-server.log >&2
  exit 1
fi
ok "Server healthy (pid $SERVER_PID)"

# ── Run the suite ─────────────────────────────────────────────────────────────
section "Suite"
# Run in the background and `wait` on it: bash defers trap handling until the
# current foreground command returns, so a foreground `node` call would make
# Ctrl-C appear to hang until the whole suite finished. `wait` is interruptible.
set +e
BASE="http://localhost:$TEST_PORT" node "$SUITE" &
SUITE_PID=$!
wait "$SUITE_PID"
SUITE_CODE=$?
set -e

if [ "$SUITE_CODE" -ne 0 ]; then
  printf '\n'
  err "Suite failed. Last 40 lines of server output:"
  tail -40 /tmp/lb-test-server.log | sed 's/^/    /' >&2
fi

exit "$SUITE_CODE"
