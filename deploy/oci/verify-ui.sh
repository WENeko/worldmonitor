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
#   3. the shell's first hashed bundle reference -> 200
#   4. GET /runs/<probe>     -> 200 text/html (deep link / browser refresh)
#   5. /openapi.json         -> application/json (the SPA mount at "/" did not
#                               swallow the REST API)
# LiteLLM's own UI on :4000/ui is reported informationally: the image tag is
# "main-stable" and its DB-backed tabs require DATABASE_URL, so a non-200 there
# is not a stack failure.
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

ASSET_PATH="$(grep -oE '(src|href)="/[^"]+\.(js|css)"' "$ROOT_BODY" | head -n1 | sed -e 's/^[a-z]*="//' -e 's/"$//')"
if [ -n "$ASSET_PATH" ]; then
  ASSET_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$ASSET_PATH" || true)"
  [ "$ASSET_CODE" = "200" ] || fail "GET $BASE$ASSET_PATH -> ${ASSET_CODE:-no response} (bundle not served)"
  ok "GET ${ASSET_PATH} -> 200 (hashed bundle)"
else
  warn "no hashed js/css reference in index.html; skipped the bundle check"
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
  UI_META="$(curl -sS -o /dev/null -L --max-time 10 -w '%{http_code} %{content_type}' "$LITELLM_URL/ui" || true)"
  ok "LiteLLM gateway alive; GET /ui -> ${UI_META} (login: admin + LITELLM_MASTER_KEY)"
else
  warn "LiteLLM is not answering on ${LITELLM_URL}/health/liveliness; skipped the /ui check"
fi

# ---------------------------------------------------------------------------
# 6. Summary
# ---------------------------------------------------------------------------
printf '%b\n' "${GREEN}Web UI verified.${NC}"
printf '%s\n' "  ssh -N -L 8899:127.0.0.1:8899 -L 4000:127.0.0.1:4000 ubuntu@<oci-host>"
printf '%s\n' "  Vibe-Trading Web UI: http://127.0.0.1:8899"
printf '%s\n' "  LiteLLM Admin UI:    http://127.0.0.1:4000/ui"
printf '%s\n' "  Use 127.0.0.1 (or localhost) through the tunnel, never the public IP:"
printf '%s\n' "  a non-loopback Host header is rejected with 403 'Untrusted local API host'."
exit 0
