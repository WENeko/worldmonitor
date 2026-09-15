#!/usr/bin/env bash
# ============================================================================
# verify-ui.sh — rebuild Vibe-Trading and PROVE the Web UI is actually served
# ============================================================================
# Run on the OCI host, from deploy/oci (invoke with bash, not ./):
#   bash verify-ui.sh              # rebuild vibe-trading + bridge, then verify
#   bash verify-ui.sh --no-build   # verify the already-running stack only
#
# Why this exists
# ---------------
# The Python package ships NO frontend: frontend/dist is gitignored, absent
# from the sdist/wheel and from MANIFEST.in. `vibe-trading serve` therefore has
# two startup paths (agent/api_server.py, serve_main) and they look identical
# from the outside:
#   [prod] Frontend served from <dir>        -> SPA mounted, browser works
#   [warn] No frontend build found at <dir>  -> API only, every page is JSON
# Both exit 0 and both leave `docker compose ps` healthy, so an image built
# without stage 1 of vibe-trading.Dockerfile fails silently — visible only in a
# browser. This script turns that into a non-zero exit with the reason.
#
# Checks (all over loopback, the same path an SSH tunnel uses)
#   1. `serve` announced a frontend dir, and it holds index.html + assets/
#   2. GET /                 -> 200 text/html, Vibe-Trading SPA shell
#   3. the shell's BUILT entry (/assets/index-<hash>.js) -> 200. Vite rewrites
#      frontend/index.html's <script src="/src/main.tsx"> at build time, so
#      finding this entry is what separates a built dist/ from a raw frontend/
#      directory dropped in by mistake. The other references in the shell
#      (/theme-boot.js, /favicon.svg, the fonts) ship from the static public/
#      dir and answer 200 even with no bundle at all.
#   4. GET /runs/<probe>     -> 200 text/html (deep link / browser refresh)
#   5. /openapi.json         -> application/json (the SPA mount at "/" did not
#                               swallow the REST API)
#   6. when `tailscale serve` fronts :8899, the very URL a browser uses
#      (https://<node>.<tailnet>.ts.net) -> the SPA shell. A reverse proxy is
#      the one path the loopback checks cannot see, and it fails in a way that
#      looks healthy everywhere else: tailscale serve forwards the browser's
#      Host header verbatim, so without API_ALLOWED_HOSTS every request answers
#      403 "Untrusted local API host". That case is named here instead of
#      surfacing as a blank page in the browser.
# LiteLLM's own UI on :4000/ui is reported informationally (the image tag is
# "main-stable"), but its BODY is inspected. Without DATABASE_URL, LiteLLM
# answers /ui with admin_ui_utils.show_missing_vars_in_env() — an "Environment
# Setup Instructions / Missing Environment Variables" page — instead of the
# app, and DISABLE_ADMIN_UI=true answers "Admin UI is Disabled". Both are HTTP
# 200 text/html and both make logging in impossible, so status + content-type
# alone would call a broken UI healthy. A non-200 there is still reported as
# informational rather than fatal.
#
# Env overrides: VIBE_CONTAINER (default vibe-trading), WAIT_S (default 120),
# VIBE_UI_URL (default http://127.0.0.1:8899).
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VIBE_CONTAINER="${VIBE_CONTAINER:-vibe-trading}"
WAIT_S="${WAIT_S:-120}"
BASE="${VIBE_UI_URL:-http://127.0.0.1:8899}"
LITELLM_URL="${LITELLM_URL:-http://127.0.0.1:4000}"
DO_BUILD=1

for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
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

command -v docker >/dev/null 2>&1 || fail "docker is not on PATH"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required"
command -v curl >/dev/null 2>&1 || fail "curl is required on the host for the HTTP checks"

# ---------------------------------------------------------------------------
# 1. Rebuild (optional)
# ---------------------------------------------------------------------------
if [ "$DO_BUILD" -eq 1 ]; then
  step "Rebuilding vibe-trading (frontend stage + image) and bridge ..."
  # bridge is FROM vibe-trading:arm64 and appears after it in
  # docker-compose.yml, so compose rebuilds it against the fresh base image.
  ( cd "$SCRIPT_DIR" && docker compose up -d --build vibe-trading bridge ) \
    || fail "docker compose up -d --build failed (see the build output above)"
fi

# ---------------------------------------------------------------------------
# 2. Wait for `serve` to announce which path it took
# ---------------------------------------------------------------------------
step "Waiting for '${VIBE_CONTAINER}' to announce its frontend (up to ${WAIT_S}s) ..."
SERVE_LOG=""
deadline=$((SECONDS + WAIT_S))
while [ "$SECONDS" -lt "$deadline" ]; do
  SERVE_LOG="$(docker logs "$VIBE_CONTAINER" --tail=300 2>&1 || true)"
  if grep -q 'No frontend build found' <<<"$SERVE_LOG"; then
    grep -m1 'No frontend build found' <<<"$SERVE_LOG" >&2
    fail "the image has no Web UI — rebuild it: docker compose up -d --build vibe-trading bridge (drop --no-build)"
  fi
  grep -q '\[prod\] Frontend served from' <<<"$SERVE_LOG" && break
  sleep 3
done

if ! grep -q '\[prod\] Frontend served from' <<<"$SERVE_LOG"; then
  printf '%s\n' "$SERVE_LOG" | tail -n 20 >&2
  fail "serve did not report a frontend within ${WAIT_S}s (log tail above; try WAIT_S=300)"
fi

FRONTEND_DIR="$(sed -n 's/.*\[prod\] Frontend served from \(.*\)$/\1/p' <<<"$SERVE_LOG" | tail -n1)"
[ -n "$FRONTEND_DIR" ] || fail "could not parse the frontend directory from the serve log"
ok "serve: [prod] Frontend served from ${FRONTEND_DIR}"

# ---------------------------------------------------------------------------
# 3. The directory it serves from is populated
# ---------------------------------------------------------------------------
docker exec "$VIBE_CONTAINER" test -f "${FRONTEND_DIR}/index.html" \
  || fail "index.html missing in ${FRONTEND_DIR}"
ASSET_COUNT="$(docker exec "$VIBE_CONTAINER" sh -c "ls '${FRONTEND_DIR}/assets' 2>/dev/null | wc -l")"
[ "${ASSET_COUNT:-0}" -gt 0 ] \
  || fail "no bundled assets in ${FRONTEND_DIR}/assets (index.html only would render a blank page)"
ok "${FRONTEND_DIR}: index.html + ${ASSET_COUNT} bundled asset file(s)"

# ---------------------------------------------------------------------------
# 4. HTTP checks over loopback
# ---------------------------------------------------------------------------
ROOT_BODY="$TMP_DIR/root.html"
DEEP_BODY="$TMP_DIR/deep.html"

ROOT_CODE="$(curl -sS -o "$ROOT_BODY" -w '%{http_code}' -H 'Accept: text/html' "$BASE/" || true)"
[ "$ROOT_CODE" = "200" ] || fail "GET $BASE/ -> ${ROOT_CODE:-no response} (expected 200)"
ROOT_TYPE="$(curl -sS -o /dev/null -w '%{content_type}' -H 'Accept: text/html' "$BASE/" || true)"
case "$ROOT_TYPE" in
  text/html*) ok "GET / -> 200 ${ROOT_TYPE} (SPA shell)" ;;
  *) fail "GET $BASE/ returned '${ROOT_TYPE}', expected text/html (API-only image?)" ;;
esac
grep -q '<title>Vibe-Trading' "$ROOT_BODY" \
  || fail "GET $BASE/ did not return the Vibe-Trading SPA shell (title marker missing)"

# The built SPA entry — the only reference in the shell that proves the HTML
# being served came out of `vite build`. A raw frontend/ directory (its
# public/ files present, /src/main.tsx entry, no bundle) passes every other
# check here and still renders a blank page.
ENTRY_PATH="$(grep -oE 'src="/assets/[^"]+\.js"' "$ROOT_BODY" | head -n1 | sed -e 's/^src="//' -e 's/"$//')"
[ -n "$ENTRY_PATH" ] \
  || fail "index.html carries no /assets/*.js module entry — the served index.html is not the built one (Vite rewrites /src/main.tsx at build time)"
ENTRY_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$ENTRY_PATH" || true)"
[ "$ENTRY_CODE" = "200" ] || fail "GET $BASE$ENTRY_PATH -> ${ENTRY_CODE:-no response} (SPA entry bundle not served)"
ok "GET ${ENTRY_PATH} -> 200 (hashed SPA entry bundle)"

# Every other absolute asset reference in the shell must resolve too, but a
# miss there is reported rather than fatal: those files are cosmetic, and a
# false failure would mask the real signal checked above.
REF_TOTAL=0
REF_MISSING=""
for REF_PATH in $(grep -oE '(src|href)="/[^"]+\.(js|css|svg|woff2)"' "$ROOT_BODY" | sed -e 's/^[a-z]*="//' -e 's/"$//' | sort -u); do
  REF_TOTAL=$((REF_TOTAL + 1))
  REF_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$REF_PATH" || true)"
  [ "$REF_CODE" = "200" ] || REF_MISSING="${REF_MISSING} ${REF_PATH}(${REF_CODE:-no response})"
done
if [ -n "$REF_MISSING" ]; then
  warn "static shell references not served:${REF_MISSING}"
else
  ok "all ${REF_TOTAL} shell asset references -> 200 (entry, theme boot, icons, fonts)"
fi

DEEP_CODE="$(curl -sS -o "$DEEP_BODY" -w '%{http_code}' -H 'Accept: text/html' "$BASE/runs/ui-verify-probe" || true)"
[ "$DEEP_CODE" = "200" ] \
  || fail "GET $BASE/runs/ui-verify-probe -> ${DEEP_CODE:-no response} (deep link must fall back to index.html)"
grep -q '<title>Vibe-Trading' "$DEEP_BODY" \
  || fail "the deep-link response was not the SPA shell"
ok "GET /runs/ui-verify-probe -> 200 (deep link falls back to index.html)"

API_TYPE="$(curl -sS -o /dev/null -w '%{content_type}' "$BASE/openapi.json" || true)"
case "$API_TYPE" in
  application/json*) ok "GET /openapi.json -> ${API_TYPE} (REST API intact)" ;;
  *) fail "GET $BASE/openapi.json returned '${API_TYPE}', expected application/json (SPA mount swallowed the API?)" ;;
esac

# ---------------------------------------------------------------------------
# 5. LiteLLM admin UI (informational)
# ---------------------------------------------------------------------------
if curl -fsS -o /dev/null --max-time 5 "$LITELLM_URL/health/liveliness" 2>/dev/null; then
  UI_BODY="$TMP_DIR/litellm-ui.html"
  UI_META="$(curl -sS -o "$UI_BODY" -L --max-time 10 -w '%{http_code} %{content_type}' "$LITELLM_URL/ui" || true)"
  UI_CODE="${UI_META%% *}"
  if grep -qi 'Environment Setup Instructions\|Missing Environment Variables' "$UI_BODY" 2>/dev/null; then
    warn "LiteLLM /ui is serving its 'Missing Environment Variables' page (${UI_META}), not the UI: the login endpoint is database-backed. Start litellm-db and check DATABASE_URL + LITELLM_SALT_KEY in docker-compose.yml."
  elif grep -qi 'Admin UI is Disabled' "$UI_BODY" 2>/dev/null; then
    warn "LiteLLM /ui reports 'Admin UI is Disabled' (${UI_META}): remove DISABLE_ADMIN_UI from the environment."
  elif [ "$UI_CODE" != "200" ]; then
    warn "GET ${LITELLM_URL}/ui -> ${UI_META} (informational; the image tag is main-stable)"
  else
    ok "LiteLLM gateway alive; GET /ui -> ${UI_META} (login: UI_USERNAME + UI_PASSWORD from .env)"
  fi
else
  warn "LiteLLM is not answering on ${LITELLM_URL}/health/liveliness; skipped the /ui check"
fi

# ---------------------------------------------------------------------------
# 6. Tailnet access (checked only when `tailscale serve` fronts this port)
# ---------------------------------------------------------------------------
# A reverse proxy is the one access path the loopback checks above cannot see,
# and it is the path a browser actually takes. `tailscale serve` forwards the
# client's Host header VERBATIM, so the API sees a loopback PEER with a
# NON-loopback Host and answers 403 "Untrusted local API host" unless that name
# is listed in API_ALLOWED_HOSTS. Everything else looks healthy in that state —
# container up, certificate valid, every loopback check green — so when a serve
# mapping targets this port, fetch the HTTPS URL and name the failure.
serve_url_for() { # $1 = loopback port; stdin = `tailscale serve status`
  awk -v port="$1" '
    /https:\/\// { url = $1 }
    $0 ~ ("127\\.0\\.0\\.1:" port "([^0-9]|$)") { if (url != "") { print url; exit } }
  '
}
TS_SERVE=""
if command -v tailscale >/dev/null 2>&1; then
  TS_SERVE="$(tailscale serve status 2>/dev/null || true)"
fi
VIBE_LOCAL_PORT="$(sed -n 's|^.*:\([0-9][0-9]*\)/*$|\1|p' <<<"$BASE" | head -n1)"
TS_VIBE_URL=""
if [ -n "$TS_SERVE" ] && [ -n "$VIBE_LOCAL_PORT" ]; then
  TS_VIBE_URL="$(printf '%s\n' "$TS_SERVE" | serve_url_for "$VIBE_LOCAL_PORT")"
fi
TS_VIBE_URL="${TS_VIBE_URL%/}"

if [ -z "$TS_VIBE_URL" ]; then
  warn "tailscale serve is not fronting 127.0.0.1:${VIBE_LOCAL_PORT:-8899}; skipped the tailnet check (see deploy/oci/tailscale/)"
else
  TS_BODY="$TMP_DIR/tailnet.html"
  TS_CODE="$(curl -sS --noproxy '*' -o "$TS_BODY" -w '%{http_code}' --max-time 20 -H 'Accept: text/html' "${TS_VIBE_URL}/" || true)"
  if grep -q 'Untrusted local API host' "$TS_BODY" 2>/dev/null; then
    fail "GET ${TS_VIBE_URL}/ -> 403 'Untrusted local API host': tailscale serve forwards the browser's Host verbatim, and the loopback DNS-rebinding guard rejects any Host it does not know. Fix: API_ALLOWED_HOSTS=<proxy hostname> in .env, then docker compose up -d vibe-trading — bash tailscale/setup-tailscale.sh derives the value and writes it."
  fi
  if grep -q 'API_AUTH_KEY is required for non-local API access' "$TS_BODY" 2>/dev/null; then
    fail "GET ${TS_VIBE_URL}/ -> 403 'API_AUTH_KEY is required for non-local API access': the API saw a NON-loopback peer, so this request did not take tailscale serve's 127.0.0.1 hop."
  fi
  [ "$TS_CODE" = "200" ] \
    || fail "GET ${TS_VIBE_URL}/ -> ${TS_CODE:-no response} (tailnet path; diagnose with: bash tailscale/setup-tailscale.sh --check)"
  grep -q '<title>Vibe-Trading' "$TS_BODY" \
    || fail "GET ${TS_VIBE_URL}/ -> 200 but not the Vibe-Trading SPA shell"
  ok "tailnet: GET ${TS_VIBE_URL}/ -> 200 (SPA shell through tailscale serve)"
fi

# ---------------------------------------------------------------------------
# 7. Summary
# ---------------------------------------------------------------------------
printf '%b\n' "${GREEN}Web UI verified.${NC}"
printf '%s\n' "  ssh -N -L 8899:127.0.0.1:8899 -L 4000:127.0.0.1:4000 ubuntu@<oci-host>"
printf '%s\n' "  Vibe-Trading Web UI: http://127.0.0.1:8899"
printf '%s\n' "  LiteLLM Admin UI:    http://127.0.0.1:4000/ui  (login: UI_USERNAME + UI_PASSWORD from .env)"
printf '%s\n' "  Use 127.0.0.1 (or localhost) through the tunnel, never the public IP:"
printf '%s\n' "  a non-loopback Host header is rejected with 403 'Untrusted local API host'."
if [ -n "$TS_VIBE_URL" ]; then
  printf '%s\n' "  Tailnet (no tunnel needed): ${TS_VIBE_URL}/"
fi
exit 0
