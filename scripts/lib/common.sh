#!/usr/bin/env bash
#
# Shared helpers for the Logbase DevOps scripts.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
#
# Compatibility: written for bash 3.2, the version macOS ships. That rules out
# associative arrays, ${var^^}, mapfile/readarray and `local -n`. Keep it that
# way so the scripts behave identically on a developer Mac and on CI's Linux.
#
# This file is meant to be sourced, never executed. Callers own `set -euo
# pipefail`; setting it here would leak shell options into interactive shells.

# ── Paths ─────────────────────────────────────────────────────────────────────
LB_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$LB_LIB_DIR/../.." && pwd)"
export ROOT

MIN_NODE_MAJOR=20

# ── Output ────────────────────────────────────────────────────────────────────
# Colours only when stdout is a TTY, so CI logs and piped output stay clean.
# shellcheck disable=SC2034  # C (cyan) is consumed by the scripts that source this
if [ -t 1 ]; then
  ESC=$(printf '\033')
  B="${ESC}[1m";  DIM="${ESC}[2m"; G="${ESC}[32m"; Y="${ESC}[33m"
  R="${ESC}[31m"; C="${ESC}[36m";  N="${ESC}[0m"
else
  B=""; DIM=""; G=""; Y=""; R=""; C=""; N=""
fi

info()    { printf '%s\n' "${DIM}·${N} $*"; }
ok()      { printf '%s\n' "${G}✓${N} $*"; }
warn()    { printf '%s\n' "${Y}!${N} $*"; }
err()     { printf '%s\n' "${R}✗${N} $*" >&2; }
die()     { err "$*"; exit 1; }

section() { printf '\n%s\n' "${B}$*${N}"; }

header() {
  printf '\n%s\n' "${B}Logbase — $1${N}"
  printf '%s\n' "${DIM}${2:-$ROOT}${N}"
}

# ── Failure tracking (used by check.sh / deploy.sh) ───────────────────────────
LB_FAILURES=0

pass_check() { ok "$*"; }
fail_check() { err "$*"; LB_FAILURES=$((LB_FAILURES + 1)); }

exit_with_failures() {
  printf '\n'
  if [ "$LB_FAILURES" -eq 0 ]; then
    ok "${B}All checks passed${N}"
    return 0
  fi
  err "${B}${LB_FAILURES} check(s) failed${N}"
  exit 1
}

# ── Prerequisites ─────────────────────────────────────────────────────────────
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1${2:+  ($2)}"
}

has_cmd() { command -v "$1" >/dev/null 2>&1; }

require_node() {
  has_cmd node || die "Node.js is not installed. Install v${MIN_NODE_MAJOR}+ from https://nodejs.org"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    die "Node $(node -v) is too old — package.json requires >=${MIN_NODE_MAJOR}.0.0"
  fi
  ok "Node $(node -v)"
}

# Install dependencies only when node_modules is missing or stale relative to
# the lockfile. Keeps repeat runs fast while never serving a stale tree.
ensure_deps() {
  local needs=0
  [ -d "$ROOT/node_modules" ] || needs=1
  if [ -d "$ROOT/node_modules" ] && [ -f "$ROOT/package-lock.json" ] \
     && [ "$ROOT/package-lock.json" -nt "$ROOT/node_modules" ]; then
    needs=1
  fi

  if [ "$needs" -eq 1 ]; then
    info "Installing dependencies…"
    if [ -f "$ROOT/package-lock.json" ]; then
      ( cd "$ROOT" && npm ci )
    else
      ( cd "$ROOT" && npm install )
    fi
    touch "$ROOT/node_modules"
    ok "Dependencies installed"
  else
    ok "Dependencies up to date"
  fi
}

# ── Environment files ─────────────────────────────────────────────────────────
# Load a .env-style file using dotenv's own precedence rule: a variable that is
# already set in the environment is never overwritten. That is what lets
# `PORT=4000 npm run dev` win over .env.local, which in turn wins over .env
# (read later by dotenv inside the Node process).
load_env_file() {
  local file="$1"
  [ -f "$file" ] || return 0

  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    line="${line#export }"
    case "$line" in *=*) ;; *) continue ;; esac

    key="${line%%=*}"
    val="${line#*=}"

    # Reject anything that is not a clean shell identifier.
    case "$key" in *[!A-Za-z0-9_]*|'') continue ;; esac

    # Strip one layer of matching quotes, as dotenv does.
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac

    # "${!key+x}" is empty only when the variable is genuinely unset.
    if [ -z "${!key+x}" ]; then
      export "$key=$val"
    fi
  done < "$file"
}

gen_secret() {
  node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
}

# A libsql:// or https:// URL means a remote Turso database — i.e. production.
is_cloud_db() {
  case "${1:-}" in
    libsql://*|https://*|wss://*) return 0 ;;
    *) return 1 ;;
  esac
}

db_label() {
  local url="${1:-<unset>}"
  if is_cloud_db "$url"; then
    printf '%s' "${Y}cloud${N}  $url"
  else
    printf '%s' "${G}local${N}  $url"
  fi
}

# ── Ports ─────────────────────────────────────────────────────────────────────
tcp_port_in_use() {
  has_cmd lsof || return 1
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

udp_port_in_use() {
  has_cmd lsof || return 1
  lsof -nP -iUDP:"$1" >/dev/null 2>&1
}

port_owner() {
  has_cmd lsof || return 0
  lsof -nP -i:"$1" 2>/dev/null | sed -n '2s/^\([^ ]*\).*/\1/p' | head -1
}

require_free_tcp_port() {
  local port="$1" hint="${2:---port <n>}"
  if tcp_port_in_use "$port"; then
    local owner; owner="$(port_owner "$port")"
    die "Port $port is already in use${owner:+ (by $owner)}. Use $hint, or stop it:  lsof -ti:$port | xargs kill"
  fi
}

# Poll an HTTP endpoint until it answers or the timeout expires.
wait_for_http() {
  local url="$1" timeout="${2:-30}" i=0
  while [ "$i" -lt "$timeout" ]; do
    if curl -sf "$url" >/dev/null 2>&1; then return 0; fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

# ── Interaction ───────────────────────────────────────────────────────────────
# Always answers "no" when stdin is not a TTY, so CI can never hang on a prompt.
confirm() {
  local prompt="$1" reply
  if [ ! -t 0 ]; then
    warn "Not a TTY — assuming 'no' for: $prompt"
    return 1
  fi
  printf '%s %s' "${Y}?${N}" "$prompt [y/N] "
  read -r reply
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}
