#!/usr/bin/env bash
#
# Logbase — static checks. No server, no database, no network.
#
#   ./scripts/check.sh           run every check
#   ./scripts/check.sh --quiet   only report failures
#   ./scripts/check.sh --help
#
# Runs in CI as the fast gate before scripts/test.sh boots anything.
# Exit code 0 = all checks passed.
#
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
cd "$ROOT"

QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --quiet|-q) QUIET=1; shift ;;
    --help|-h)  sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1  (try --help)" ;;
  esac
done

say() { [ "$QUIET" -eq 1 ] || pass_check "$@"; }

header "check"
require_node >/dev/null
ensure_deps  >/dev/null

# ── 1. JavaScript syntax ──────────────────────────────────────────────────────
section "Syntax"
JS_COUNT=0
SYNTAX_BAD=0
while IFS= read -r f; do
  JS_COUNT=$((JS_COUNT + 1))
  if ! node --check "$f" 2>/tmp/lb-syntax.err; then
    fail_check "Syntax error in $f"
    sed 's/^/    /' /tmp/lb-syntax.err >&2
    SYNTAX_BAD=1
  fi
done < <(find src scripts tools .github -name '*.js' -not -path '*/node_modules/*' 2>/dev/null)
[ "$SYNTAX_BAD" -eq 0 ] && say "$JS_COUNT JavaScript file(s) parse cleanly"

# Browser assets use ES modules / DOM globals, so `node --check` is still a
# valid parse test (it checks syntax only, never resolves globals).
PUB_COUNT=0
PUB_BAD=0
while IFS= read -r f; do
  PUB_COUNT=$((PUB_COUNT + 1))
  if ! node --check "$f" 2>/tmp/lb-syntax.err; then
    fail_check "Syntax error in $f"
    sed 's/^/    /' /tmp/lb-syntax.err >&2
    PUB_BAD=1
  fi
done < <(find public -name '*.js' 2>/dev/null)
[ "$PUB_BAD" -eq 0 ] && [ "$PUB_COUNT" -gt 0 ] && say "$PUB_COUNT browser script(s) parse cleanly"

# ── 2. Shell syntax ───────────────────────────────────────────────────────────
SH_BAD=0
SH_COUNT=0
while IFS= read -r f; do
  SH_COUNT=$((SH_COUNT + 1))
  if ! bash -n "$f" 2>/tmp/lb-sh.err; then
    fail_check "Shell syntax error in $f"
    sed 's/^/    /' /tmp/lb-sh.err >&2
    SH_BAD=1
  fi
done < <(find scripts -name '*.sh' 2>/dev/null)
[ "$SH_BAD" -eq 0 ] && say "$SH_COUNT shell script(s) parse cleanly"

if has_cmd shellcheck; then
  if shellcheck -S warning scripts/*.sh scripts/lib/*.sh >/tmp/lb-shellcheck.out 2>&1; then
    say "shellcheck clean"
  else
    warn "shellcheck reported issues (non-fatal):"
    sed 's/^/    /' /tmp/lb-shellcheck.out | head -40
  fi
fi

# ── 3. JSON validity ──────────────────────────────────────────────────────────
section "JSON"
JSON_BAD=0
for f in package.json package-lock.json \
         src/db/schema/tables.json src/db/schema/indexes.json src/db/schema/migrations.json; do
  [ -f "$f" ] || continue
  if ! node -e "require('./$f')" 2>/tmp/lb-json.err; then
    fail_check "Invalid JSON: $f"
    sed 's/^/    /' /tmp/lb-json.err >&2
    JSON_BAD=1
  fi
done
[ "$JSON_BAD" -eq 0 ] && say "JSON files are valid"

# ── 4. Database schema compiles ───────────────────────────────────────────────
section "Schema"
if OUT="$(node -e "
  const t = require('./src/db/schema/tables.json');
  const i = require('./src/db/schema/indexes.json');
  const m = require('./src/db/schema/migrations.json');
  const Adapter = require('./src/db/adapters/libsql');
  const a = Object.create(Adapter.prototype);
  const ddl = a.compileSchema(t, i);

  // Introspection-based migrations (guardedColumns) branch on the live schema,
  // so compile them against both shapes they must handle:
  //   fresh  — no tables yet; compileSchema() will create them complete
  //   legacy — every table present but missing the newest columns
  const fresh = new Map();
  const legacy = new Map(
    t.map(tb => [tb.name, new Set(tb.columns.map(c => c.name))])
  );
  for (const x of m) { a.compileMigration(x, fresh); a.compileMigration(x, legacy); }

  console.log(ddl.length + ' DDL statements, ' + m.length + ' migrations');
" 2>&1)"; then
  say "Schema compiles — $OUT"
else
  fail_check "Schema failed to compile"
  printf '%s\n' "$OUT" | sed 's/^/    /' >&2
fi

# ── 5. Modules load without side effects ──────────────────────────────────────
# Requiring src/db/database.js constructs the adapter at module scope, so a
# database URL must be present. An in-memory database keeps this check true to
# its name: no file is created, nothing to clean up, and a fresh checkout (CI,
# a new clone, the Docker image) behaves exactly like a developer machine.
#
# `env -i` clears the environment so a developer's .env — which points at the
# *cloud* database — can never be picked up by a static check.
section "Modules"
if OUT="$(env -i PATH="$PATH" HOME="$HOME" node -e "
  process.env.TURSO_DATABASE_URL = ':memory:';
  process.env.JWT_SECRET = 'check-only';
  const mods = [
    './src/ingest/registry', './src/ingest/formats', './src/ingest/pipeline',
    './src/ingest/listenerManager', './src/middleware/collectorAuth',
    './src/routes/auth', './src/routes/logs', './src/routes/oauth', './src/routes/collectors',
  ];
  mods.forEach(m => require(m));
  console.log(mods.length + ' modules loaded');
" 2>&1)"; then
  say "$OUT"
else
  fail_check "A module failed to load"
  printf '%s\n' "$OUT" | sed 's/^/    /' >&2
fi

# ── 6. Environment documentation drift ────────────────────────────────────────
# Every process.env.X read by src/ should appear in .env.example, so a new
# deployment knob can never ship undocumented.
section "Environment"
# Set by the platform or by the process itself — not user-configurable.
RUNTIME_PROVIDED="RENDER NODE_ENV"
MISSING=""
# Strip comments first: adapters/base.js documents process.env.DATABASE_URL in a
# JSDoc example, which is not a variable this app actually reads.
for key in $(node -e "
  const fs = require('fs'), path = require('path');
  const found = new Set();
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
        .replace(/^\s*\/\/.*$/gm, '');      // whole-line comments
      for (const m of src.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) found.add(m[1]);
    }
  })('src');
  console.log([...found].sort().join('\n'));
" 2>/dev/null); do
  case " $RUNTIME_PROVIDED " in *" $key "*) continue ;; esac
  grep -qE "^#? *${key}=" .env.example || MISSING="$MISSING $key"
done
if [ -z "$MISSING" ]; then
  say "All src/ environment variables are documented in .env.example"
else
  fail_check "Undocumented in .env.example:$MISSING"
fi

# ── 7. Secret scan ────────────────────────────────────────────────────────────
section "Secrets"
LEAKS=0

# Tracked .env would publish real credentials.
if git -C "$ROOT" ls-files --error-unmatch .env >/dev/null 2>&1; then
  fail_check ".env is tracked by git — it must stay ignored"
  LEAKS=1
fi

# Live credential patterns in tracked source (placeholders excluded).
PATTERNS='ghp_[A-Za-z0-9]{36}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.|libsql://[a-z0-9-]+\.turso\.io'
if git -C "$ROOT" grep -nIE "$PATTERNS" -- \
     ':!*.md' ':!.env.example' ':!package-lock.json' >/tmp/lb-secrets.out 2>/dev/null; then
  fail_check "Possible credential in tracked source:"
  sed 's/^/    /' /tmp/lb-secrets.out >&2
  LEAKS=1
fi
[ "$LEAKS" -eq 0 ] && say "No credentials detected in tracked files"

# The git remote is a common place for a leaked token.
REMOTE="$(git -C "$ROOT" remote get-url origin 2>/dev/null || true)"
case "$REMOTE" in
  *@github.com*|*:*@*) warn "Git remote embeds a credential — revoke it and use:  git remote set-url origin https://github.com/<owner>/<repo>.git" ;;
esac

# ── 8. Repository hygiene ─────────────────────────────────────────────────────
section "Hygiene"
STRAY="$(git -C "$ROOT" ls-files | grep -E '\.(db|sqlite|sqlite3|log)$' || true)"
if [ -z "$STRAY" ]; then
  say "No database or log artefacts tracked"
else
  fail_check "Runtime artefacts are tracked by git:"
  printf '%s\n' "$STRAY" | sed 's/^/    /' >&2
fi

# lib/ is sourced, never executed, so it is intentionally not executable.
NONEXEC="$(find scripts -maxdepth 1 -name '*.sh' -not -perm -u+x 2>/dev/null || true)"
if [ -z "$NONEXEC" ]; then
  say "All scripts are executable"
else
  fail_check "Scripts missing the executable bit:"
  printf '%s\n' "$NONEXEC" | sed 's/^/    /' >&2
  info "Fix with:  chmod +x scripts/*.sh"
fi

exit_with_failures
