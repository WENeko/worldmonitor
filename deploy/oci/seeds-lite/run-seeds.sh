#!/bin/sh
# seeds-lite — staggered keyless seeder loop (WorldMonitor fork on OCI).
#
# Runs a small subset of scripts/seed-*.mjs on independent cadences, writing
# into the fork's Upstash Redis so the Vercel `/mcp` tools (get_world_brief,
# get_news_intelligence, conflict/ucdp/gdelt data) serve fresh data without
# the operator-side Railway relay.
#
# Properties (kept boring on purpose):
#   - Per-seeder wall-clock cap through timeout(1), bounding the blast radius
#     of a hung upstream fetch (same rationale as scripts/run-seeders.sh).
#   - A failed seeder never kills the loop or its siblings: rc is logged, the
#     next tick retries.
#   - Cadences are enforced with last-run timestamps in $STATE_DIR, so the
#     loop sleeps a short tick even when heavier seeders run rarely.
#   - Output is written to a capped state file and its tail is echoed to
#     stdout so `docker logs seeds-lite` stays useful.
#
# Required env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
# Optional env: OPENROUTER_API_KEY (richer LLM news briefs — degraded
#               headlines-only mode works without it), SEEDS_LITE_TICK_S,
#               SEEDS_LITE_DEBUG
set -u

SEEDS_DIR="/app/scripts"
STATE_DIR="/var/lib/seeds-lite"
TICK_S="${SEEDS_LITE_TICK_S:-60}"

mkdir -p "$STATE_DIR"

log() { echo "[$(date -u +%FT%TZ)] $*"; }
fail() { log "FATAL: $*"; exit 1; }

[ -n "${UPSTASH_REDIS_REST_URL:-}" ] || fail "UPSTASH_REDIS_REST_URL is required (add it to deploy/oci/.env)"
[ -n "${UPSTASH_REDIS_REST_TOKEN:-}" ] || fail "UPSTASH_REDIS_REST_TOKEN is required (add it to deploy/oci/.env)"
command -v node >/dev/null 2>&1 || fail "node not found in image"
command -v timeout >/dev/null 2>&1 || fail "timeout(1) not found in image"

# name | cadence_seconds | seed script | per-run cap seconds
# Cadences are intentionally LOOSER than upstream defaults to stay inside the
# Upstash free tier (500k requests/month per database). Each seeder issues
# several individual REST commands per run (no pipelining), so run frequency
# — not payload size — dominates quota burn. Measured bottleneck:
# military-flights at 10min ≈ 23 commands/run ≈ ~100k req/month alone.
# Trade-off accepted: fork health may report STALE for stretched datasets
# (cosmetic for the Hermès/MCP consumers). Re-tighten after a paid upgrade.
#   - military-flights: 30min (health maxStaleMin=30) — was 10min
#   - ucdp: DISABLED until UCDP_ACCESS_TOKEN is provided (it only burned quota
#     on 401 retries every 15min; re-enable after the token lands)
#   - insights/conflict/gdelt-bulk: 60min — was 15/15/30min
#   - social-velocity: relay parity (ais-relay.cjs runs every 3h; faster
#     polling trips Reddit datacenter-IP rate limits)
PLAN="
insights         | 3600 | seed-insights.mjs                | 1200
conflict         | 3600 | seed-conflict-intel.mjs          | 1500
gdelt-bulk       | 3600 | seed-gdelt-bulk-materializer.mjs | 2400
military-flights | 1800 | seed-military-flights.mjs        | 600
social-velocity  | 10800| seed-social-velocity.mjs         | 300
"

should_run() {
  name=$1; cadence=$2
  f="$STATE_DIR/last_$name"
  [ ! -f "$f" ] && return 0
  now=$(date +%s)
  prev=$(cat "$f" 2>/dev/null || echo 0)
  [ $((now - prev)) -ge "$cadence" ]
}

run_seed() {
  name=$1; cadence=$2; script=$3; cap=$4

  if ! should_run "$name" "$cadence"; then
    [ "${SEEDS_LITE_DEBUG:-0}" = "1" ] && log "$name — not due yet (cadence ${cadence}s)"
    return 0
  fi

  out="$STATE_DIR/out_$name.log"
  log "── $name — START (node scripts/$script, cap ${cap}s)"
  if timeout -k 30 "$cap" node "$SEEDS_DIR/$script" >"$out" 2>&1; then
    log "── $name — OK ($(tail -1 "$out" | cut -c1-160))"
    tail -5 "$out"
  else
    rc=$?
    log "── $name — FAIL rc=$rc (retry next tick; full log in $out)"
    tail -25 "$out"
  fi
  date +%s > "$STATE_DIR/last_$name"

  # Keep per-seed logs bounded.
  size=$(wc -c < "$out" 2>/dev/null || echo 0)
  [ "$size" -gt 300000 ] && : > "$out"
}

log "seeds-lite started — tick ${TICK_S}s"
log "Upstash target: ${UPSTASH_REDIS_REST_URL}"
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  log "OpenRouter key present — news briefs will be LLM-enriched"
else
  log "No OpenRouter key — news briefs degraded (headlines only)"
fi

while :; do
  tick_start=$(date +%s)

  echo "$PLAN" | grep -v '^[[:space:]]*$' | while IFS='|' read -r name cadence script cap; do
    [ -z "${name:-}" ] && continue
    run_seed "$(echo "$name" | tr -d ' ')" "$(echo "$cadence" | tr -d ' ')" \
             "$(echo "$script" | tr -d ' ')" "$(echo "$cap" | tr -d ' ')"
  done

  elapsed=$(( $(date +%s) - tick_start ))
  if [ "$elapsed" -lt "$TICK_S" ]; then
    remain=$(( TICK_S - elapsed ))
    # Slice the sleep so SIGTERM from `docker stop` is honored promptly.
    while [ "$remain" -gt 0 ]; do
      sleep 2
      remain=$(( remain - 2 ))
    done
  fi
done