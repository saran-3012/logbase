#!/usr/bin/env bash
#
# Logbase — deployment preflight and release to Render.
#
#   ./scripts/deploy.sh                 preflight only (no push) — safe default
#   ./scripts/deploy.sh --push          preflight, then push the current branch
#   ./scripts/deploy.sh --push --yes    non-interactive (CI)
#   ./scripts/deploy.sh --branch master push a specific branch
#   ./scripts/deploy.sh --help
#
# Render auto-deploys on push, so the push IS the deploy. Everything that can
# fail is checked here first; nothing is pushed unless every gate passes.
#
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
cd "$ROOT"

PUSH=0
ASSUME_YES=0
BRANCH=""
SKIP_TESTS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --push)       PUSH=1; shift ;;
    --yes|-y)     ASSUME_YES=1; shift ;;
    --branch|-b)  BRANCH="${2:-}"; [ -n "$BRANCH" ] || die "--branch needs a value"; shift 2 ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --help|-h)    sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1  (try --help)" ;;
  esac
done

header "deploy preflight"
need_cmd git
require_node >/dev/null

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BRANCH="${BRANCH:-$CURRENT_BRANCH}"

# ── 1. Static checks ──────────────────────────────────────────────────────────
section "Static checks"
if ./scripts/check.sh --quiet; then
  ok "check.sh passed"
else
  die "Static checks failed — fix them before deploying"
fi

# ── 2. End-to-end tests ───────────────────────────────────────────────────────
if [ "$SKIP_TESTS" -eq 1 ]; then
  warn "Skipping end-to-end tests (--skip-tests)"
else
  section "End-to-end tests"
  if ./scripts/test.sh >/tmp/lb-deploy-test.log 2>&1; then
    ok "test.sh passed ($(grep -cE '^  PASS' /tmp/lb-deploy-test.log || echo '?') assertions)"
  else
    err "End-to-end tests failed:"
    tail -30 /tmp/lb-deploy-test.log | sed 's/^/    /' >&2
    die "Fix the failures before deploying"
  fi
fi

# ── 3. Deployment configuration ───────────────────────────────────────────────
section "Deployment configuration"
[ -f render.yaml ]  && ok "render.yaml present"  || warn "render.yaml missing — Render will use dashboard settings"
[ -f Dockerfile ]   && ok "Dockerfile present"   || warn "Dockerfile missing"

# The start command Render runs must not depend on devDependencies.
START_CMD="$(node -p "require('./package.json').scripts.start" 2>/dev/null || echo '')"
case "$START_CMD" in
  node*) ok "start script is production-safe: $START_CMD" ;;
  *)     fail_check "start script must invoke node directly (found: $START_CMD)" ;;
esac

# Render installs with --omit=dev; anything required at runtime must be a
# regular dependency.
if node -e "
  const pkg = require('./package.json');
  const dev = Object.keys(pkg.devDependencies || {});
  const fs = require('fs'), path = require('path');
  const bad = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of dev) {
          if (new RegExp(\"require\\\\(['\\\"]\" + m).test(src)) bad.push(p + ' -> ' + m);
        }
      }
    }
  })('src');
  if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
" 2>/tmp/lb-devdep.out; then
  ok "src/ does not require any devDependency"
else
  fail_check "src/ requires a devDependency (absent in production):"
  sed 's/^/    /' /tmp/lb-devdep.out >&2
fi

# ── 4. Git state ──────────────────────────────────────────────────────────────
section "Git"
printf '  %s  %s\n' "Branch" "${C}${BRANCH}${N}"

DIRTY="$(git status --porcelain)"
if [ -z "$DIRTY" ]; then
  ok "Working tree clean"
else
  warn "Uncommitted changes — these will NOT be deployed:"
  printf '%s\n' "$DIRTY" | sed 's/^/    /'
fi

if git rev-parse --abbrev-ref "@{upstream}" >/dev/null 2>&1; then
  AHEAD="$(git rev-list --count "@{upstream}..HEAD" 2>/dev/null || echo 0)"
  BEHIND="$(git rev-list --count "HEAD..@{upstream}" 2>/dev/null || echo 0)"
  [ "$AHEAD"  -gt 0 ] && info "$AHEAD commit(s) ahead of upstream"
  [ "$BEHIND" -gt 0 ] && warn "$BEHIND commit(s) behind upstream — pull before pushing"
else
  info "No upstream set for $BRANCH"
fi

# ── 5. Migration warning ──────────────────────────────────────────────────────
section "Migrations"
PENDING="$(node -p "require('./src/db/schema/migrations.json').length" 2>/dev/null || echo '?')"
info "$PENDING migration(s) defined — the server applies pending ones on boot"
# Detection only — the listing is printed once, in the else branch.
if node -e "
  const m = require('./src/db/schema/migrations.json');
  const destructive = m.filter(x =>
    JSON.stringify(x).match(/DROP TABLE|DROP TRIGGER|dropTable/i));
  process.exit(destructive.length ? 2 : 0);
" 2>/dev/null; then
  ok "No destructive migrations defined"
else
  node -e "
    const m = require('./src/db/schema/migrations.json');
    m.filter(x => JSON.stringify(x).match(/DROP TABLE|DROP TRIGGER|dropTable/i))
     .forEach(d => console.log('    v' + d.version + ' — ' + (d.description || d.name || '')));
  "
  warn "${B}Destructive migration(s) above run automatically on first boot.${N}"
  warn "Data in the dropped tables is permanently lost on a database that has not applied them yet."
fi

# ── 6. Summary / push ─────────────────────────────────────────────────────────
if [ "$LB_FAILURES" -gt 0 ]; then
  printf '\n'
  die "${LB_FAILURES} preflight check(s) failed — not deploying"
fi

printf '\n'
ok "${B}Preflight passed${N}"

if [ "$PUSH" -eq 0 ]; then
  printf '\n'
  info "Preflight only. To deploy:  ./scripts/deploy.sh --push"
  exit 0
fi

printf '\n'
warn "Pushing ${B}${BRANCH}${N} triggers an automatic Render deploy."

if [ "$ASSUME_YES" -eq 0 ]; then
  confirm "Push $BRANCH to origin now?" || { info "Aborted — nothing pushed"; exit 0; }
fi

section "Push"
git push origin "$BRANCH"
ok "Pushed $BRANCH"

printf '\n'
info "Watch the deploy at https://dashboard.render.com"
info "Expect:  [db] Applied migration …  →  Server running"
info "Then verify:  curl -sf https://<your-app>.onrender.com/healthz"
