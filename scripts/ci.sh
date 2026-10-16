#!/usr/bin/env bash
#
# Logbase — the full CI pipeline, runnable locally and identical in GitHub Actions.
#
#   ./scripts/ci.sh        static checks, then end-to-end tests
#   ./scripts/ci.sh --help
#
# Keeping CI as a script rather than inline YAML means "it passed locally" and
# "it passed in CI" mean the same thing.
#
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
cd "$ROOT"

case "${1:-}" in
  --help|-h) sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) die "Unknown option: $1  (try --help)" ;;
esac

START=$(date +%s)
header "CI"

printf '\n%s\n' "${B}── Stage 1/2 · static checks ────────────────────────────────${N}"
./scripts/check.sh

printf '\n%s\n' "${B}── Stage 2/2 · end-to-end tests ─────────────────────────────${N}"
./scripts/test.sh

printf '\n'
ok "${B}CI passed${N} ${DIM}($(( $(date +%s) - START ))s)${N}"
