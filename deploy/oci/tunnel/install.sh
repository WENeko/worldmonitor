#!/usr/bin/env bash
# ============================================================================
# install.sh — register ocitunnel on the OPERATOR's machine (Linux / macOS)
# ============================================================================
# Run this on the machine that has the browser, not on the OCI host:
#   bash install.sh ubuntu@130.61.235.29                  # key from ssh config
#   bash install.sh ubuntu@130.61.235.29 ~/.ssh/id_ed25519
#   bash install.sh --uninstall
#
# What it does: copies ocitunnel.sh to ~/.local/bin/ocitunnel/, writes
# ~/.config/ocitunnel/config, then registers a service with the platform's own
# supervisor — systemd user unit on Linux, LaunchAgent on macOS — so the tunnel
# comes back on every login, after every reboot and after every network drop,
# with no terminal left open.
#
# Flags: --force (overwrite an existing config) · --no-start (install only)
# Exit codes: 0 ok · 1 unsupported platform or a failed command · 2 bad usage
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/ocitunnel.sh"
BIN_DIR="$HOME/.local/bin/ocitunnel"
BIN="$BIN_DIR/ocitunnel.sh"
CONFIG_DIR="$HOME/.config/ocitunnel"
CONFIG_FILE="$CONFIG_DIR/config"
UNIT_NAME="ocitunnel"
LABEL="com.worldmonitor.ocitunnel"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { printf '%b\n' "  ${GREEN}ok${NC}   $*"; }
warn() { printf '%b\n' "  ${YELLOW}warn${NC} $*"; }
fail() { printf '%b\n' "${RED}FAIL${NC}  $*" >&2; exit 1; }
step() { printf '%b\n' "${GREEN}$*${NC}"; }

TARGET_HOST=""
IDENTITY=""
FORWARDS="8899:127.0.0.1:8899 4000:127.0.0.1:4000"
DO_FORCE=0
DO_START=1
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --force)     DO_FORCE=1 ;;
    --no-start)  DO_START=0 ;;
    -h|--help)   sed -n '2,18p' "$0"; exit 0 ;;
    -*)          printf 'unknown flag: %s\n' "$1" >&2; exit 2 ;;
    *)           if [ -z "$TARGET_HOST" ]; then TARGET_HOST="$1"; else IDENTITY="$1"; fi ;;
  esac
  shift
done

OS="$(uname -s)"
case "$OS" in
  Linux)  PLATFORM=systemd ;;
  Darwin) PLATFORM=launchd ;;
  *)      fail "unsupported platform '$OS'. On Windows use install-windows.ps1; on WSL use the Linux path." ;;
esac

# $USER is not set everywhere (cron, some container images, a bare systemd
# unit), and $UID is not POSIX. Resolve both once instead of tripping set -u.
CURRENT_USER="${USER:-$(id -un)}"
CURRENT_UID="${UID:-$(id -u)}"

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
  if [ "$PLATFORM" = systemd ]; then
    systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1
    rm -f "$HOME/.config/systemd/user/$UNIT_NAME.service"
    systemctl --user daemon-reload >/dev/null 2>&1
    ok "systemd user unit $UNIT_NAME removed and stopped"
  else
    launchctl bootout "gui/$CURRENT_UID/$LABEL" >/dev/null 2>&1
    rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
    ok "LaunchAgent $LABEL removed and stopped"
  fi
  printf '%s\n' "Kept: $BIN and $CONFIG_FILE (delete them by hand if you want a clean slate)."
  exit 0
fi

[ -n "$TARGET_HOST" ] || fail "usage: bash install.sh <user@host> [identity_file]   (target host is required)"
case "$TARGET_HOST" in
  *'<'*|*'>'*) fail "replace the placeholder: pass the real address, e.g. ubuntu@130.61.235.29" ;;
  *@*) ;;
  *) warn "no user@ prefix on '$TARGET_HOST': ssh will use your current local user name on the host" ;;
esac
[ -f "$SRC" ] || fail "ocitunnel.sh not found next to this script ($SRC)"

# The mistake this catches has already happened once: installing the tunnel on
# the OCI host itself, where there is no browser to use it.
if [ -n "${SSH_CONNECTION:-}" ]; then
  warn "SSH_CONNECTION is set, so this looks like a remote shell. The tunnel must run on the"
  warn "machine with the BROWSER, not on the OCI host — otherwise the UI only opens inside ssh."
  printf '%b' "  continue anyway? [y/N] "
  read -r reply
  case "$reply" in y|Y|yes|YES) ;; *) printf 'aborted.\n'; exit 1 ;; esac
fi

# ---------------------------------------------------------------------------
# Binary + config
# ---------------------------------------------------------------------------
step "Installing on this machine ($PLATFORM)"
mkdir -p "$BIN_DIR" "$CONFIG_DIR" || fail "could not create $BIN_DIR"
cp "$SRC" "$BIN" && chmod 755 "$BIN" || fail "could not copy ocitunnel.sh to $BIN"
ok "script: $BIN"

if [ -f "$CONFIG_FILE" ] && [ "$DO_FORCE" -eq 0 ]; then
  warn "config kept: $CONFIG_FILE (pass --force to rewrite it)"
  if ! grep -q -- "$TARGET_HOST" "$CONFIG_FILE"; then
    warn "note: it does not mention '$TARGET_HOST' — edit it if the target changed"
  fi
else
  cat > "$CONFIG_FILE" <<EOF
# ocitunnel — read by $BIN, one KEY=value per line (shell syntax).
OCITUNNEL_HOST='$TARGET_HOST'
OCITUNNEL_FORWARDS='$FORWARDS'
OCITUNNEL_IDENTITY='$IDENTITY'
# Unattended runs never prompt. If --check reports "Permission denied
# (publickey)", copy your key first: ssh-copy-id ${TARGET_HOST##*@}
OCITUNNEL_BATCHMODE=yes
# SSH options appended verbatim (e.g. a bastion): OCITUNNEL_SSH_OPTS=''
OCITUNNEL_SSH_OPTS=''
OCITUNNEL_BACKOFF_MIN=5
OCITUNNEL_BACKOFF_MAX=60
EOF
  chmod 600 "$CONFIG_FILE"
  ok "config: $CONFIG_FILE"
fi

# ---------------------------------------------------------------------------
# Service registration
# ---------------------------------------------------------------------------
if [ "$PLATFORM" = systemd ]; then
  systemctl --user show-environment >/dev/null 2>&1 \
    || fail "systemd --user is not available in this session (no user manager / not booted with systemd)"

  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR" || fail "could not create $UNIT_DIR"
  BASH_BIN="$(command -v bash || printf '/bin/bash')"
  cat > "$UNIT_DIR/$UNIT_NAME.service" <<EOF
[Unit]
Description=ocitunnel — SSH tunnel to the Hermes stack UIs (Vibe-Trading :8899, LiteLLM :4000)
Documentation=file:$BIN
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BASH_BIN $BIN
# ssh dies on suspend, Wi-Fi changes and OCI reboots; the unit and the script
# both retry, so the tunnel survives all three without anyone watching.
Restart=always
RestartSec=10
TimeoutStopSec=15
KillMode=mixed

[Install]
WantedBy=default.target
EOF
  ok "unit: $UNIT_DIR/$UNIT_NAME.service"
  systemctl --user daemon-reload || fail "systemctl --user daemon-reload failed"
  if [ "$DO_START" -eq 1 ]; then
    systemctl --user enable --now "$UNIT_NAME" || fail "systemctl --user enable --now $UNIT_NAME failed"
    ok "enabled and started"
    sleep 2
    systemctl --user --no-pager --lines=5 status "$UNIT_NAME" || true
  else
    ok "installed (not started: --no-start)"
  fi
  printf '\n'
  printf '  status:  systemctl --user status %s\n' "$UNIT_NAME"
  printf '  logs:    journalctl --user -u %s -f\n' "$UNIT_NAME"
  printf '  restart: systemctl --user restart %s\n' "$UNIT_NAME"
  printf '  remove:  bash %s --uninstall\n' "$0"
  if command -v loginctl >/dev/null 2>&1 \
     && ! loginctl show-user "$CURRENT_USER" -p Linger --value 2>/dev/null | grep -qx yes; then
    printf '%b\n' "  ${YELLOW}Survive a reboot with nobody logged in:  sudo loginctl enable-linger $CURRENT_USER${NC}"
  fi
else
  AGENT_DIR="$HOME/Library/LaunchAgents"
  LOG_DIR="$HOME/Library/Logs"
  mkdir -p "$AGENT_DIR" "$LOG_DIR" || fail "could not create $AGENT_DIR"
  cat > "$AGENT_DIR/$LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <!-- Absolute paths only: launchd does not expand \$HOME or environment vars. -->
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$BIN</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG_DIR/ocitunnel.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/ocitunnel.log</string>
</dict>
</plist>
EOF
  ok "agent: $AGENT_DIR/$LABEL.plist"
  launchctl bootout "gui/$CURRENT_UID/$LABEL" >/dev/null 2>&1
  if [ "$DO_START" -eq 1 ]; then
    launchctl bootstrap "gui/$CURRENT_UID" "$AGENT_DIR/$LABEL.plist" || fail "launchctl bootstrap failed"
    launchctl kickstart -k "gui/$CURRENT_UID/$LABEL" >/dev/null 2>&1
    ok "loaded and started"
  else
    ok "installed (not loaded: --no-start)"
  fi
  printf '\n'
  printf '  status:  launchctl print gui/%s/%s | head -20\n' "$CURRENT_UID" "$LABEL"
  printf '  logs:    tail -f %s/ocitunnel.log\n' "$LOG_DIR"
  printf '  restart: launchctl kickstart -k gui/%s/%s\n' "$CURRENT_UID" "$LABEL"
  printf '  remove:  bash %s --uninstall\n' "$0"
fi

printf '\n%s\n' "Check it end to end (from another terminal, tunnel service running):"
printf '%s\n' "  bash $BIN --check"
printf '%s\n' "  curl -sS -o /dev/null -w 'vibe-trading: %{http_code}\\n' http://127.0.0.1:8899/"
printf '%s\n' "  curl -sS -o /dev/null -w 'litellm ui:    %{http_code}\\n' -L http://127.0.0.1:4000/ui"
