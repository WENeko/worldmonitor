#!/usr/bin/env bash
# ============================================================================
# ocitunnel.sh — keep the operator UIs reachable on YOUR machine, unattended
# ----------------------------------------------------------------------------
# Runs on the operator's machine, NOT on the OCI host. Invoke with bash:
#   bash ocitunnel.sh           supervised: reconnect forever (this is what
#                               install.sh registers as a login/boot service)
#   bash ocitunnel.sh --once    one foreground ssh, like the manual command
#   bash ocitunnel.sh --check   prerequisites + reachability, named failures
#   bash ocitunnel.sh --print   print the exact command that would run, exit
#
# Why not a bare `ssh -N -L ...`
# -----------------------------
# The stack binds the UIs to loopback on the host (8899 Vibe-Trading, 4000
# LiteLLM — see "Operator UI access" in env.template). A bare ssh tunnel dies
# on laptop sleep, a Wi-Fi change, a NAT timeout or an OCI reboot, and nothing
# brings it back: the UI just looks broken, with no error anywhere. This is the
# same tunnel wrapped in a reconnect loop, which is what makes it safe to run as
# a service that nobody watches.
#
# Config file (default ~/.config/ocitunnel/config) — written by install.sh:
#   OCITUNNEL_HOST='ubuntu@130.61.235.29'           # required; <oci-host> must
#                                                   # be replaced by a real host
#   OCITUNNEL_FORWARDS='8899:127.0.0.1:8899 4000:127.0.0.1:4000'
#   OCITUNNEL_IDENTITY=''                           # optional, passed as -i
#   OCITUNNEL_SSH_OPTS=''                           # optional, extra ssh options
#   OCITUNNEL_BATCHMODE=yes                         # unattended runs never prompt
#   OCITUNNEL_BACKOFF_MIN=5  OCITUNNEL_BACKOFF_MAX=60
# Environment variables of the same name win over the file, so a one-off
# `OCITUNNEL_HOST=ubuntu@other bash ocitunnel.sh --once` also works.
#
# Exit codes: 0 ok · 1 ssh failed or a --check probe failed · 2 bad usage
# ============================================================================

set -uo pipefail

CONFIG_FILE="${OCITUNNEL_CONFIG:-$HOME/.config/ocitunnel/config}"

# The caller's environment must win over the config file, so remember what was
# passed before sourcing it.
_env_host="${OCITUNNEL_HOST:-}"
_env_forwards="${OCITUNNEL_FORWARDS:-}"
_env_identity="${OCITUNNEL_IDENTITY:-}"
_env_ssh_opts="${OCITUNNEL_SSH_OPTS:-}"
_env_batchmode="${OCITUNNEL_BATCHMODE:-}"
_env_backoff_min="${OCITUNNEL_BACKOFF_MIN:-}"
_env_backoff_max="${OCITUNNEL_BACKOFF_MAX:-}"

if [ -r "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
fi

HOST="${_env_host:-${OCITUNNEL_HOST:-}}"
FORWARDS="${_env_forwards:-${OCITUNNEL_FORWARDS:-8899:127.0.0.1:8899 4000:127.0.0.1:4000}}"
IDENTITY="${_env_identity:-${OCITUNNEL_IDENTITY:-}}"
SSH_OPTS_EXTRA="${_env_ssh_opts:-${OCITUNNEL_SSH_OPTS:-}}"
BATCHMODE="${_env_batchmode:-${OCITUNNEL_BATCHMODE:-yes}}"
BACKOFF_MIN="${_env_backoff_min:-${OCITUNNEL_BACKOFF_MIN:-5}}"
BACKOFF_MAX="${_env_backoff_max:-${OCITUNNEL_BACKOFF_MAX:-60}}"
# A connection that lived at least this long counts as healthy, so the backoff
# resets (a flapping link does not, and keeps backing off instead).
STABLE_S="${OCITUNNEL_STABLE_S:-60}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { printf '%b\n' "  ${GREEN}ok${NC}   $*"; }
warn() { printf '%b\n' "  ${YELLOW}warn${NC} $*"; }
fail() { printf '%b\n' "${RED}FAIL${NC}  $*" >&2; exit 1; }
log()  { printf '%s [ocitunnel] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

MODE=run
for arg in "$@"; do
  case "$arg" in
    --once)  MODE=once ;;
    --check) MODE=check ;;
    --print) MODE=print ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

command -v ssh >/dev/null 2>&1 || fail "ssh is not on PATH"
[ -n "$HOST" ] || fail "OCITUNNEL_HOST is not set (config file: $CONFIG_FILE)"
case "$HOST" in
  *'<'*|*'>'*) fail "OCITUNNEL_HOST is still the placeholder '$HOST': put the real user@host in $CONFIG_FILE" ;;
esac
[ -n "$FORWARDS" ] || fail "OCITUNNEL_FORWARDS is empty: there is nothing to forward"

# Options shared by the tunnel and the --check probe. BatchMode=yes makes an
# unattended run fail loudly instead of hanging on a password prompt; use an SSH
# key (ssh-copy-id) if --check reports "Permission denied (publickey)".
BASE_OPTS=(
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  -o ExitOnForwardFailure=yes
  -o TCPKeepAlive=yes
  -o ConnectTimeout=15
  -o BatchMode="$BATCHMODE"
)
[ -n "$IDENTITY" ] && BASE_OPTS+=(-i "$IDENTITY")
if [ -n "$SSH_OPTS_EXTRA" ]; then
  # Unquoted on purpose: the value is a whitespace-separated list of ssh options.
  # shellcheck disable=SC2206
  BASE_OPTS+=($SSH_OPTS_EXTRA)
fi

# -N: no remote command, the connection only carries the forwards. Both arrays
# keep at least one element so "${arr[@]}" stays safe under `set -u` on the
# bash 3.2 that macOS still ships.
SSH_OPTS=(-N "${BASE_OPTS[@]}")

L_OPTS=()
for fwd in $FORWARDS; do
  case "$fwd" in
    :*:*|*:|*::*|*:*:) fail "malformed forward '$fwd' (expected LOCAL_PORT:127.0.0.1:REMOTE_PORT)" ;;
    *:*:*) L_OPTS+=(-L "$fwd") ;;
    *)     fail "malformed forward '$fwd' (expected LOCAL_PORT:127.0.0.1:REMOTE_PORT)" ;;
  esac
done
[ "${#L_OPTS[@]}" -gt 0 ] || fail "no usable forward in '$FORWARDS'"

local_port_busy() { # $1 = port; 0 busy · 1 free · 2 unknown
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltn "sport = :$1" 2>/dev/null | grep -q .
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 2
  fi
}

run_tunnel() {
  if command -v autossh >/dev/null 2>&1; then
    # AUTOSSH_GATETIME=0 is the important bit: without it autossh gives up for
    # good when the *first* connection fails inside the gate time (host still
    # booting, no Wi-Fi yet), which is exactly the case a boot-time service hits.
    AUTOSSH_GATETIME=0 autossh -M 0 "${SSH_OPTS[@]}" "${L_OPTS[@]}" "$HOST"
  else
    ssh "${SSH_OPTS[@]}" "${L_OPTS[@]}" "$HOST"
  fi
}

# ---------------------------------------------------------------------------
# --print : the exact command, for copy-paste or a bug report
# ---------------------------------------------------------------------------
if [ "$MODE" = print ]; then
  if command -v autossh >/dev/null 2>&1; then
    printf 'AUTOSSH_GATETIME=0 autossh -M 0 %s %s %s\n' "${SSH_OPTS[*]}" "${L_OPTS[*]}" "$HOST"
  else
    printf 'ssh %s %s %s\n' "${SSH_OPTS[*]}" "${L_OPTS[*]}" "$HOST"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# --check : a real gate. Safe to run any time; it is deliberately NOT wired as
# systemd ExecStartPre, because a transient network outage at boot would then
# mark the unit failed instead of letting the retry loop do its job.
# ---------------------------------------------------------------------------
if [ "$MODE" = check ]; then
  printf 'ocitunnel prerequisites\n'
  if [ -r "$CONFIG_FILE" ]; then
    ok "config file: $CONFIG_FILE"
  else
    warn "no config file at $CONFIG_FILE (environment variables only)"
  fi
  ok "target: $HOST"
  ok "forwards: $FORWARDS"
  if command -v autossh >/dev/null 2>&1; then
    ok "autossh present: ssh is restarted inside autossh (faster recovery)"
  else
    warn "autossh not installed: this script supervises ssh itself (works, but recovery waits for ServerAlive to time out). 'sudo apt install autossh' or 'brew install autossh' shortens that."
  fi

  for fwd in $FORWARDS; do
    port="${fwd%%:*}"
    local_port_busy "$port"; busy=$?
    case "$busy" in
      0) warn "local port ${port} already has a listener: either ocitunnel is already running (fine) or another process holds it (the tunnel will refuse to bind and retry forever)" ;;
      1) ok "local port ${port} free" ;;
      *) warn "local port ${port}: cannot check (neither ss nor lsof)" ;;
    esac
  done

  TMP_DIR="$(mktemp -d 2>/dev/null || printf '/tmp/ocitunnel-check-%s' "$$")"
  trap 'rm -rf "$TMP_DIR"' EXIT
  if ssh "${BASE_OPTS[@]}" "$HOST" true 2>"$TMP_DIR/probe.err"; then
    ok "ssh login works without a prompt (key auth): $HOST"
  else
    warn "ssh probe failed: $(tr '\n' ' ' <"$TMP_DIR/probe.err" | sed 's/  */ /g' | cut -c1-200)"
    printf '%b\n' "       ${YELLOW}If that says \"Permission denied (publickey)\", this machine has no key for $HOST yet: run"
    printf '%b\n' "       ${YELLOW}ssh-copy-id ${HOST##*@} (or set OCITUNNEL_IDENTITY in $CONFIG_FILE). An unattended"
    printf '%b\n' "       ${YELLOW}tunnel cannot answer a password prompt.${NC}"
    exit 1
  fi

  printf '\n'
  printf '  Vibe-Trading Web UI: http://127.0.0.1:8899\n'
  printf '  LiteLLM Admin UI:    http://127.0.0.1:4000/ui  (login: UI_USERNAME + UI_PASSWORD from .env)\n'
  printf '  Use 127.0.0.1 (or localhost), never the OCI public IP:\n'
  printf '  a non-loopback Host header is rejected with 403 "Untrusted local API host".\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# run / --once
# ---------------------------------------------------------------------------
if [ "$MODE" = once ]; then
  log "connecting once: ${HOST} <- ${FORWARDS}"
  run_tunnel
  rc=$?
  log "exited rc=${rc} (--once: not reconnecting)"
  exit "$rc"
fi

attempt=0
backoff="$BACKOFF_MIN"
while :; do
  attempt=$((attempt + 1))
  started=$(date +%s)
  log "connecting (attempt ${attempt}) <- ${FORWARDS}"
  run_tunnel
  rc=$?
  lived=$(( $(date +%s) - started ))
  log "tunnel exited rc=${rc} after ${lived}s"

  if [ "$lived" -ge "$STABLE_S" ]; then
    backoff="$BACKOFF_MIN"                 # it held long enough: reset
  else
    backoff=$(( backoff * 2 ))
    [ "$backoff" -gt "$BACKOFF_MAX" ] && backoff="$BACKOFF_MAX"
  fi
  log "retrying in ${backoff}s"
  sleep "$backoff"
done
