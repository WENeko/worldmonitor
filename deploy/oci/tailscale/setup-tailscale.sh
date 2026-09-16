#!/usr/bin/env bash
# ============================================================================
# setup-tailscale.sh — serve both operator UIs to your tailnet, from the OCI host
# ============================================================================
# Run ON THE OCI HOST — that is the point of this path: the host itself serves
# the UI, so no SSH tunnel and no client-side script are needed on any device.
# From deploy/oci:
#
#   bash tailscale/setup-tailscale.sh            # configure, verify, update .env
#   bash tailscale/setup-tailscale.sh --check    # report only, changes nothing
#   bash tailscale/setup-tailscale.sh --dry-run  # print what would change
#   bash tailscale/setup-tailscale.sh --install  # install Tailscale first
#   bash tailscale/setup-tailscale.sh --reset    # drop the serve mappings
#
# What it produces
#   https://<node>.<tailnet>.ts.net/          Vibe-Trading Web UI + REST API
#   https://<node>.<tailnet>.ts.net:8443/ui   LiteLLM Admin UI
#
# Reachable from any device already on your tailnet — laptop, phone, browser —
# with a real, automatically renewed TLS certificate, and with NO port opened in
# the OCI ingress rules (8899/4000 stay loopback-only).
#
# Why this shape fits Vibe-Trading
# --------------------------------
# `tailscale serve` terminates TLS and reverse proxies to http://127.0.0.1:<port>,
# so the API sees a LOOPBACK peer — the same trust path an SSH tunnel uses. That
# keeps VIBE_TRADING_API_AUTH_KEY unnecessary (no bearer token to paste into the
# SPA) while non-loopback traffic stays refused.
#
# The trap this script exists to close
# ------------------------------------
# `tailscale serve` forwards the client's Host header VERBATIM to the backend.
# Vibe-Trading's DNS-rebinding middleware (_reject_untrusted_loopback_host,
# agent/src/api/security.py) trusts a loopback peer but rejects any Host that is
# neither loopback nor listed in API_ALLOWED_HOSTS — so the result of a
# *correctly configured* proxy is
#   403 {"detail": "Untrusted local API host"}
# on every request: container healthy, certificate valid, UI unusable, and
# nothing in `docker compose ps` or the container logs saying why. The fix is
# API_ALLOWED_HOSTS=<this node's MagicDNS name>. This script derives that name,
# writes it into .env (docker-compose.yml passes it through to the container),
# recreates vibe-trading, then proves the whole path with its own HTTPS request.
#
# Env overrides: ENV_FILE, VIBE_PORT (8899), LITELLM_PORT (4000),
#   HTTPS_PORT (443), HTTPS_LITELLM_PORT (8443), WAIT_S (90), SERVE_TIMEOUT (180).
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$COMPOSE_DIR/.env}"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.yml"
VIBE_PORT="${VIBE_PORT:-8899}"
LITELLM_PORT="${LITELLM_PORT:-4000}"
HTTPS_PORT="${HTTPS_PORT:-443}"
HTTPS_LITELLM_PORT="${HTTPS_LITELLM_PORT:-8443}"
WAIT_S="${WAIT_S:-90}"
# `tailscale serve --bg` blocks while it provisions the TLS certificate — usually
# well under a minute. Past this budget the ACME order is wedged, not slow, and
# an indefinite wait is indistinguishable from a hang (observed in the field).
SERVE_TIMEOUT="${SERVE_TIMEOUT:-180}"

DO_INSTALL=0; DO_DRY_RUN=0; DO_CHECK=0; DO_RESET=0
for arg in "$@"; do
  case "$arg" in
    --install)  DO_INSTALL=1 ;;
    --dry-run)  DO_DRY_RUN=1 ;;
    --check)    DO_CHECK=1 ;;
    --reset)    DO_RESET=1 ;;
    -h|--help)  sed -n '2,40p' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { printf '%b\n' "  ${GREEN}ok${NC}   $*"; }
warn() { printf '%b\n' "  ${YELLOW}warn${NC} $*"; }
fail() { printf '%b\n' "${RED}FAIL${NC}  $*" >&2; exit 1; }
step() { printf '%b\n' "${GREEN}$*${NC}"; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

url_for_port() { # $1 = https port on the MagicDNS name
  if [ "$1" = "443" ]; then printf 'https://%s' "$DNS_NAME"; else printf 'https://%s:%s' "$DNS_NAME" "$1"; fi
}

# ---------------------------------------------------------------------------
# 0. Tailscale installed
# ---------------------------------------------------------------------------
if ! command -v tailscale >/dev/null 2>&1; then
  if [ "$DO_INSTALL" -eq 1 ] && [ "$DO_DRY_RUN" -eq 0 ]; then
    step "Installing Tailscale (official installer) ..."
    curl -fsSL https://tailscale.com/install.sh | sh \
      || fail "the Tailscale installer failed; see its output above"
  else
    fail "tailscale is not installed on this host. Install it with:
        curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
      (or rerun this script with --install). On OCI a fresh install needs no
      ingress change: Tailscale dials out, it never listens publicly."
  fi
fi
command -v tailscale >/dev/null 2>&1 \
  || fail "the installer finished but 'tailscale' is still not on PATH"

# `tailscale serve` is privileged. Prefer passwordless sudo (the OCI ubuntu
# default) and fall back to a prompting sudo, so this works whether it is
# launched as root or as the login user.
if [ "$(id -u)" -eq 0 ]; then
  TS=(tailscale)
elif command -v sudo >/dev/null 2>&1; then
  if sudo -n true 2>/dev/null; then TS=(sudo -n tailscale); else TS=(sudo tailscale); fi
else
  fail "tailscale serve needs root and sudo is unavailable: rerun this script as root"
fi

# ---------------------------------------------------------------------------
# 1. Daemon answering, node connected, MagicDNS name known
# ---------------------------------------------------------------------------
STATUS_JSON="$("${TS[@]}" status --json 2>"$TMP_DIR/status.err" || true)"
if [ -z "$STATUS_JSON" ]; then
  sed -n '1,3p' "$TMP_DIR/status.err" >&2
  fail "'tailscale status --json' answered nothing: the daemon is probably not running
      (sudo systemctl enable --now tailscaled) or this user is not authorized to
      talk to it (sudo tailscale up)."
fi

BACKEND_STATE="$(sed -n 's/.*"BackendState": *"\([^"]*\)".*/\1/p' <<<"$STATUS_JSON" | head -n1)"
[ -n "$BACKEND_STATE" ] || BACKEND_STATE="unknown"
[ "$BACKEND_STATE" = "Running" ] \
  || fail "this node is not connected to your tailnet (BackendState=${BACKEND_STATE}).
      Run: sudo tailscale up   (and follow the login URL it prints)"
ok "tailscale daemon responding; node connected (BackendState=Running)"

# The ts.net FQDN assigned to this node. python3 is precise; the sed fallback
# reads the first "DNSName" in the JSON, which belongs to Self.
magic_dns_name() {
  local json="$1" name=""
  if command -v python3 >/dev/null 2>&1; then
    name="$(printf '%s' "$json" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("Self") or {}).get("DNSName","").rstrip("."))' 2>/dev/null)"
  fi
  if [ -z "$name" ]; then
    name="$(printf '%s' "$json" | sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' | head -n1 | sed 's/\.$//')"
  fi
  printf '%s' "$name"
}
DNS_NAME="$(magic_dns_name "$STATUS_JSON")"
[ -n "$DNS_NAME" ] \
  || fail "this node has no MagicDNS name, so there is no hostname to get a
      certificate for. Enable MagicDNS and HTTPS Certificates for your tailnet
      (Tailscale admin console -> DNS), then rerun."
ok "MagicDNS name: ${DNS_NAME}"

# ---------------------------------------------------------------------------
# 2. --reset
# ---------------------------------------------------------------------------
if [ "$DO_RESET" -eq 1 ]; then
  if [ "$DO_DRY_RUN" -eq 1 ]; then
    warn "dry-run: would run: tailscale serve reset"
    exit 0
  fi
  step "Removing all tailscale serve mappings on this node ..."
  "${TS[@]}" serve reset >"$TMP_DIR/reset.out" 2>&1 \
    || { sed -n '1,5p' "$TMP_DIR/reset.out" >&2; fail "tailscale serve reset failed"; }
  ok "tailscale serve reset (no mapping is published to the tailnet any more)"
  printf '%s\n' "API_ALLOWED_HOSTS in ${ENV_FILE} is harmless once nothing proxies to"
  printf '%s\n' ":${VIBE_PORT}; remove that entry as well if you stop serving the UI over the tailnet."
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. --check
# ---------------------------------------------------------------------------
if [ "$DO_CHECK" -eq 1 ]; then
  step "Current tailscale serve configuration:"
  "${TS[@]}" serve status 2>&1 | sed 's/^/  /' || true
fi

# ---------------------------------------------------------------------------
# 4. API_ALLOWED_HOSTS in .env (the whole reason a proxy alone is not enough)
# ---------------------------------------------------------------------------
env_value() { # $1 = file, $2 = key -> current value, empty when absent
  sed -n "s/^[[:space:]]*$2=//p" "$1" 2>/dev/null | tail -n1 | tr -d '"'
}
upsert_env_var() { # $1 = file, $2 = key, $3 = value; rewrites only that key's line
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  if grep -qE "^[[:space:]]*${key}=" "$file" 2>/dev/null; then
    awk -v k="$key" -v v="$value" '
      $0 ~ "^[[:space:]]*" k "=" { if (!done) { print k "=" v; done = 1 } ; next }
      { print }
    ' "$file" > "$tmp"
  else
    { cat "$file" 2>/dev/null; printf '%s=%s\n' "$key" "$value"; } > "$tmp"
  fi
  chmod --reference="$file" "$tmp" 2>/dev/null || true
  mv "$tmp" "$file"
}

# Existing entries are kept (a reverse proxy added by hand, another name for the
# same UI) and the MagicDNS name is appended once — order preserved, duplicates
# dropped, so the line only ever grows by what is genuinely missing.
merge_allowed_hosts() { # $1 = current value, $2 = host to ensure
  local out="" entry
  local IFS=','
  for entry in $1 $2; do
    entry="$(printf '%s' "$entry" | tr -d '[:space:]')"
    [ -n "$entry" ] || continue
    case ",$out," in *",$entry,"*) continue ;; esac
    out="${out:+$out,}$entry"
  done
  printf '%s' "$out"
}

CURRENT_ALLOWED="$(env_value "$ENV_FILE" API_ALLOWED_HOSTS)"
NEW_ALLOWED="$(merge_allowed_hosts "$CURRENT_ALLOWED" "$DNS_NAME")"
[ -n "$NEW_ALLOWED" ] || fail "could not derive the API_ALLOWED_HOSTS value"
ENV_CHANGED=0

if [ "$NEW_ALLOWED" = "$CURRENT_ALLOWED" ]; then
  ok "API_ALLOWED_HOSTS already lists ${DNS_NAME} in .env"
elif [ ! -f "$ENV_FILE" ]; then
  warn "no .env at ${ENV_FILE} (run setup.sh first); it must contain API_ALLOWED_HOSTS=${NEW_ALLOWED}"
elif [ "$DO_DRY_RUN" -eq 1 ]; then
  warn "dry-run: would set API_ALLOWED_HOSTS=${NEW_ALLOWED} in ${ENV_FILE} (was: ${CURRENT_ALLOWED:-unset})"
else
  upsert_env_var "$ENV_FILE" API_ALLOWED_HOSTS "$NEW_ALLOWED"
  ENV_CHANGED=1
  ok "API_ALLOWED_HOSTS=${NEW_ALLOWED} written to .env (only that line changed)"
fi

# A value in .env is useless if the container never sees it: this is the second
# half of the 403, and it silently fails on a checkout that predates the key.
grep -q 'API_ALLOWED_HOSTS' "$COMPOSE_FILE" \
  || fail "docker-compose.yml does not pass API_ALLOWED_HOSTS into the vibe-trading
      container, so the value above cannot reach the API and every request
      through the proxy will answer 403 'Untrusted local API host'.
      Update this checkout (git pull on this host) and rerun."

if [ "$ENV_CHANGED" -eq 1 ] && [ "$DO_DRY_RUN" -eq 0 ]; then
  if command -v docker >/dev/null 2>&1; then
    step "Recreating vibe-trading so the container picks up API_ALLOWED_HOSTS ..."
    ( cd "$COMPOSE_DIR" && docker compose up -d vibe-trading ) \
      || fail "docker compose up -d vibe-trading failed (see the output above)"
  else
    warn "docker is not on PATH here; run it yourself: cd ${COMPOSE_DIR} && docker compose up -d vibe-trading"
  fi
fi

# ---------------------------------------------------------------------------
# 4b. --check ends here: report only — no publishing, no probing. Probing in
# check mode used to FAIL with 'connection refused' on a host that simply has
# no serve mappings yet, reading like a breakage when nothing was broken.
# ---------------------------------------------------------------------------
if [ "$DO_CHECK" -eq 1 ]; then
  printf '%b\n' "${GREEN}Check complete — nothing was changed.${NC}"
  if "${TS[@]}" serve status 2>&1 | grep -qi 'no serve config'; then
    printf '%s\n' "  No serve mappings exist yet, so there is nothing to probe. Run without"
    printf '%s\n' "  --check to publish https://${DNS_NAME}/ and the LiteLLM mapping, then verify."
  else
    printf '%s\n' "  Mappings exist; run without --check to re-verify the HTTPS path end to end."
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# 5. Publish the two mappings
# ---------------------------------------------------------------------------
if [ "$DO_CHECK" -eq 0 ]; then
  if [ "$DO_DRY_RUN" -eq 1 ]; then
    warn "dry-run: would run: tailscale serve --bg --yes --https=${HTTPS_PORT} http://127.0.0.1:${VIBE_PORT}"
    warn "dry-run: would run: tailscale serve --bg --yes --https=${HTTPS_LITELLM_PORT} http://127.0.0.1:${LITELLM_PORT}"
  else
    step "Publishing ${DNS_NAME} to your tailnet (TLS certificate is fetched on first use) ..."
    if ! timeout "$SERVE_TIMEOUT" "${TS[@]}" serve --bg --yes --https="$HTTPS_PORT" "http://127.0.0.1:${VIBE_PORT}" >"$TMP_DIR/serve-vibe.out" 2>&1; then
      sed -n '1,6p' "$TMP_DIR/serve-vibe.out" >&2
      if grep -qiE 'serve is not enabled' "$TMP_DIR/serve-vibe.out" 2>/dev/null; then
        approve_url="$(grep -oE 'https://login\.tailscale\.com/f/serve\?node=[A-Za-z0-9]+' "$TMP_DIR/serve-vibe.out" | head -n1)"
        fail "tailscaled refused to publish: the tailnet-level Serve feature is not enabled yet.
      Approve it in a browser logged in as the tailnet admin${approve_url:+: ${approve_url}}
      (one-time per tailnet; the URL is also printed by tailscale itself above),
      then rerun this script. While in the admin console, check DNS ->
      HTTPS Certificates is on — the certificate request comes right after."
      fi
      fail "tailscale serve did not return within ${SERVE_TIMEOUT}s for https:${HTTPS_PORT} -> 127.0.0.1:${VIBE_PORT}.
      serve blocks while provisioning the TLS certificate; past ~2 min the ACME
      order is wedged, not slow. See the actual error with:
        sudo tailscale cert ${DNS_NAME}
        sudo journalctl -u tailscaled --since '-20 min' | grep -iE 'cert|acme|rate|error' | tail -30
      'sudo systemctl restart tailscaled' unwedges it in most cases; then rerun."
    fi
    ok "tailscale serve: $(url_for_port "$HTTPS_PORT") -> http://127.0.0.1:${VIBE_PORT}  (Web UI + REST API)"

    if timeout "$SERVE_TIMEOUT" "${TS[@]}" serve --bg --yes --https="$HTTPS_LITELLM_PORT" "http://127.0.0.1:${LITELLM_PORT}" >"$TMP_DIR/serve-litellm.out" 2>&1; then
      ok "tailscale serve: $(url_for_port "$HTTPS_LITELLM_PORT") -> http://127.0.0.1:${LITELLM_PORT}  (Admin UI at /ui)"
    else
      warn "could not publish the LiteLLM mapping on https:${HTTPS_LITELLM_PORT}: $(sed -n '1,2p' "$TMP_DIR/serve-litellm.out" | tr '\n' ' ')"
      warn "the Vibe-Trading mapping above is unaffected; retry later or pick another HTTPS_LITELLM_PORT"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 6. Prove the browser's path, not the loopback one
# ---------------------------------------------------------------------------
if [ "$DO_DRY_RUN" -eq 1 ]; then
  printf '%b\n' "${GREEN}Dry run complete — nothing was changed.${NC}"
  exit 0
fi

probe_vibe() {
  local url="$1/" body="$TMP_DIR/probe.html" err="$TMP_DIR/probe.err" code="" entry ecode
  local deadline=$((SECONDS + WAIT_S))
  step "Probing ${url} (the first request provisions the certificate; up to ${WAIT_S}s) ..."
  while [ "$SECONDS" -lt "$deadline" ]; do
    code="$(curl -sS --noproxy '*' -o "$body" -w '%{http_code}' --max-time 15 -H 'Accept: text/html' "$url" 2>"$err" || true)"
    [ "$code" = "200" ] && break
    # A 403 is the API answering a configuration question, not a slow start.
    grep -q 'Untrusted local API host\|API_AUTH_KEY is required' "$body" 2>/dev/null && break
    sleep 3
  done

  if grep -q 'Untrusted local API host' "$body" 2>/dev/null; then
    fail "tailnet: ${url} -> 403 'Untrusted local API host'.
      The proxy reached the API, but the Host header it forwarded (${DNS_NAME}) is
      not trusted. Set API_ALLOWED_HOSTS=${DNS_NAME} in ${ENV_FILE} and recreate the
      container: cd ${COMPOSE_DIR} && docker compose up -d vibe-trading"
  fi
  if grep -q 'API_AUTH_KEY is required for non-local API access' "$body" 2>/dev/null; then
    fail "tailnet: ${url} -> 403 'API_AUTH_KEY is required for non-local API access'.
      The API saw a NON-loopback peer, so the request did not come through
      tailscale serve's 127.0.0.1 hop — check that the mapping targets
      http://127.0.0.1:${VIBE_PORT} and nothing else (tailscale serve status)."
  fi
  [ "$code" = "200" ] \
    || { sed -n '1,3p' "$err" >&2 2>/dev/null
         fail "tailnet: ${url} -> ${code:-no response}.
      Check: 'tailscale serve status', that MagicDNS + HTTPS Certificates are
      enabled for the tailnet, and that ${DNS_NAME} resolves on the devices you
      browse from." ; }
  grep -q '<title>Vibe-Trading' "$body" \
    || fail "tailnet: ${url} -> 200 but not the Vibe-Trading SPA shell (a proxy in front may be answering, not serve)"
  ok "tailnet: ${url} -> 200 (Vibe-Trading SPA shell)"

  # The entry bundle over the proxy proves assets traverse it too, not just "/".
  entry="$(grep -oE 'src="/assets/[^"]+\.js"' "$body" | head -n1 | sed -e 's/^src="//' -e 's/"$//')"
  if [ -n "$entry" ]; then
    ecode="$(curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 15 "${url%/}${entry}" || true)"
    [ "$ecode" = "200" ] \
      || fail "tailnet: GET ${url%/}${entry} -> ${ecode:-no response} (SPA entry bundle not served through the proxy)"
    ok "tailnet: ${entry} -> 200 through the proxy (hashed SPA entry bundle)"
  else
    warn "the proxied shell carries no /assets/*.js entry; run: bash verify-ui.sh --no-build"
  fi
}

probe_vibe "$(url_for_port "$HTTPS_PORT")"

LITELLM_TS_URL="$(url_for_port "$HTTPS_LITELLM_PORT")/ui"
LITELLM_BODY="$TMP_DIR/litellm.html"
LITELLM_META="$(curl -sS --noproxy '*' -o "$LITELLM_BODY" -L --max-time 20 -w '%{http_code} %{content_type}' "$LITELLM_TS_URL" || true)"
if grep -qi 'Environment Setup Instructions\|Missing Environment Variables' "$LITELLM_BODY" 2>/dev/null; then
  warn "tailnet: ${LITELLM_TS_URL} -> ${LITELLM_META}: LiteLLM is serving its 'Missing Environment Variables' page, not the UI (needs DATABASE_URL — litellm-db). See env.template."
elif grep -qi 'Admin UI is Disabled' "$LITELLM_BODY" 2>/dev/null; then
  warn "tailnet: ${LITELLM_TS_URL} -> ${LITELLM_META}: 'Admin UI is Disabled' (DISABLE_ADMIN_UI is set)."
elif [ "${LITELLM_META%% *}" = "200" ]; then
  ok "tailnet: ${LITELLM_TS_URL} -> ${LITELLM_META} (login: UI_USERNAME + UI_PASSWORD)"
else
  warn "tailnet: ${LITELLM_TS_URL} -> ${LITELLM_META} (informational; the litellm image tag is main-stable)"
fi

# ---------------------------------------------------------------------------
# 7. Summary
# ---------------------------------------------------------------------------
printf '%b\n' "${GREEN}Tailnet access configured.${NC}"
printf '%s\n' "  Vibe-Trading Web UI: $(url_for_port "$HTTPS_PORT")"
printf '%s\n' "  LiteLLM Admin UI:    ${LITELLM_TS_URL}  (login: UI_USERNAME + UI_PASSWORD from .env)"
printf '%s\n' "  Open these from any device already on your tailnet — no tunnel, no port"
printf '%s\n' "  forwarding, and nothing to open in the OCI ingress rules (8899/${LITELLM_PORT} stay loopback-only)."
printf '%s\n' "  Survives reboots: 'tailscale serve --bg' resumes automatically."
printf '%s\n' "  Change later with HTTPS_PORT / HTTPS_LITELLM_PORT, or undo with --reset."
exit 0
