#!/usr/bin/env bash
#
# Logbase — database operations.
#
#   ./scripts/db.sh status            show target, schema version, row counts
#   ./scripts/db.sh backup            copy the local database into data/backups/
#   ./scripts/db.sh reset             DESTRUCTIVE: drop and recreate the schema
#   ./scripts/db.sh console           open sqlite3 against the local database
#   ./scripts/db.sh --help
#
# Defaults to the LOCAL database from .env.local. Add --turso to target the
# cloud database from .env — required for anything destructive, so production
# can never be hit by accident.
#
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
cd "$ROOT"

USE_TURSO=0
ASSUME_YES=0
CMD="${1:-}"
[ $# -gt 0 ] && shift || true

while [ $# -gt 0 ]; do
  case "$1" in
    --turso)  USE_TURSO=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    *) die "Unknown option: $1  (try --help)" ;;
  esac
done

case "$CMD" in
  --help|-h|"") sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

header "database"
require_node >/dev/null

# ── Resolve the target ────────────────────────────────────────────────────────
if [ "$USE_TURSO" -eq 1 ]; then
  [ -f "$ROOT/.env" ] || die "--turso needs a .env file"
  load_env_file "$ROOT/.env"
  warn "Targeting the ${B}CLOUD${N} database"
else
  [ -f "$ROOT/.env.local" ] || die "No .env.local — run ./scripts/setup.sh first"
  load_env_file "$ROOT/.env.local"
fi

DB_URL="${TURSO_DATABASE_URL:-}"
[ -n "$DB_URL" ] || die "TURSO_DATABASE_URL is not set"
printf '  %s  %s\n\n' "Target" "$(db_label "$DB_URL")"

# file:./data/local.db → /abs/path/data/local.db  (empty for remote databases)
local_db_path() {
  case "$DB_URL" in
    file:*) local p="${DB_URL#file:}"; case "$p" in /*) printf '%s' "$p" ;; *) printf '%s' "$ROOT/${p#./}" ;; esac ;;
    *) printf '' ;;
  esac
}

case "$CMD" in
  status)
    section "Schema"
    # Uses the adapter's raw get() rather than the query builder: this is a
    # read-only inspection, and get() returns a row object directly.
    TURSO_DATABASE_URL="$DB_URL" node -e "
      const db = require('$ROOT/src/db/database');
      (async () => {
        const defined = require('$ROOT/src/db/schema/migrations.json').length;
        let applied = null;
        try {
          const row = await db.get('SELECT version FROM _schema_version LIMIT 1');
          applied = row ? Number(row.version) : 0;
        } catch { /* table absent */ }

        if (applied === null) {
          console.log('  Schema version   not initialised — start the app once');
        } else {
          const state = applied < defined ? '  (pending migrations)' : '  (up to date)';
          console.log('  Schema version   ' + applied + ' of ' + defined + state);
        }

        for (const t of ['users', 'collectors', 'collector_credentials', 'logs']) {
          let out = '—';
          try {
            const row = await db.get('SELECT COUNT(*) AS n FROM ' + t);
            out = String(row ? row.n : 0);
          } catch { /* table absent */ }
          console.log('  ' + t.padEnd(22) + out);
        }
      })().catch(e => { console.error('  Failed:', e.message); process.exit(1); });
    "
    P="$(local_db_path)"
    if [ -n "$P" ] && [ -f "$P" ]; then
      section "File"
      printf '  %s  %s\n' "Path" "$P"
      printf '  %s  %s\n' "Size" "$(du -h "$P" | cut -f1)"
    fi
    ;;

  backup)
    P="$(local_db_path)"
    [ -n "$P" ] || die "Backup only supports local file databases. For Turso use:  turso db shell <db> .dump"
    [ -f "$P" ] || die "Database file not found: $P"

    mkdir -p "$ROOT/data/backups"
    DEST="$ROOT/data/backups/$(basename "$P" .db)-$(date +%Y%m%d-%H%M%S).db"

    # VACUUM INTO produces a consistent snapshot even with an active WAL;
    # a plain cp can capture a torn state.
    if has_cmd sqlite3; then
      sqlite3 "$P" "VACUUM INTO '$DEST'"
    else
      cp "$P" "$DEST"
      warn "sqlite3 not found — used a plain copy (stop the server first for consistency)"
    fi
    ok "Backup written: ${DEST#"$ROOT"/}  ($(du -h "$DEST" | cut -f1))"
    ;;

  reset)
    warn "${B}This deletes ALL data — users, logs, collectors and credentials.${N}"
    if [ "$USE_TURSO" -eq 1 ]; then
      warn "${R}${B}The target is the CLOUD database.${N}"
    fi
    if [ "$ASSUME_YES" -eq 0 ]; then
      confirm "Proceed with the reset?" || { info "Aborted — nothing changed"; exit 0; }
    fi
    TURSO_DATABASE_URL="$DB_URL" node "$ROOT/scripts/db-reset.js" --yes
    ;;

  console)
    P="$(local_db_path)"
    [ -n "$P" ] || die "Console only supports local file databases. For Turso use:  turso db shell <db>"
    need_cmd sqlite3 "install with: brew install sqlite3"
    [ -f "$P" ] || die "Database file not found: $P — start the app once to create it"
    info "sqlite3 $P   (.tables, .schema logs, .quit)"
    exec sqlite3 "$P"
    ;;

  *)
    die "Unknown command: $CMD  (try --help)"
    ;;
esac
