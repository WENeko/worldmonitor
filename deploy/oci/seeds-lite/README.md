# seeds-lite

Keyless seeder loop for a WorldMonitor fork deployed without the operator-side
Railway relay. It runs a small subset of the repo's `scripts/seed-*.mjs` on
staggered cadences and writes into the fork's Upstash Redis, so the Vercel
`/mcp` data tools serve fresh data.

## Why it exists

The MCP tools (`get_world_brief`, `get_news_intelligence`, UCDP/GDELT/conflict
sources) read keys seeded into Redis by the operator's relay (Railway). A fork
that only deploys the Vercel side of the stack has a cold Redis: health reports
`EMPTY`/`STALE_SEED` and the tools fail with `Internal error: data fetch
failed`. This service runs the **keyless** seeders that cover those keys —
nothing here needs an API credential (ACLED, FRED, Finnhub etc. are simply not
scheduled; `seed-conflict-intel.mjs` itself skips ACLED when
`ACLED_EMAIL`/`ACLED_PASSWORD` are absent).

## Seeder plan

| Name | Cadence | Seed script | Covers (health keys) |
|---|---|---|---|
| `insights` | 2 h | `seed-insights.mjs` | `newsInsights` → `get_world_brief`, `get_news_intelligence` (headlines-only without `OPENROUTER_API_KEY`, LLM-enriched with it) |
| `ucdp` | disabled | `seed-ucdp-events.mjs` | `ucdpEvents` (+ bootstrap) — off until `UCDP_ACCESS_TOKEN` is set |
| `conflict` | 60 min | `seed-conflict-intel.mjs` | `acledIntel` via HAPI HDX (ACLED-derived, open), GDELT conflict feed, humanitarian keys |
| `gdelt-bulk` | 2 h | `seed-gdelt-bulk-materializer.mjs` | `gdeltIntel` (the production producer since #5843) — 2 h is the hard ceiling (8-file catch-up cap) |
| `military-flights` | 60 min | `seed-military-flights.mjs` | `militaryFlights` — keyless via adsb.lol + Wingbits; data stays present via 24 h STALE fallback keys |
| `social-velocity` | 6 h | `seed-social-velocity.mjs` (fork-owned, in this dir) | `socialVelocity` → `get_social_velocity` — mini port of the relay's Reddit loop (worldnews + geopolitics, velocity-scored) |

Cadences are stretched from upstream defaults to fit the Upstash free tier
(500k commands/month per database) — each seeder issues several individual
REST commands per run, so run frequency, not payload size, dominates quota
burn. The 12-hourly `seed-upstash.yml` full-fleet cron (the previous biggest
burner, tens of thousands of commands per run) was removed 2026-09-02; on
2026-09-03 the cadences above were stretched again after the fork DB reached
431k/500k monthly commands. Each cadence is bounded by the seeder's own data
TTL so keys never expire between runs; the fork accepts `STALE` health flags
on the stretched datasets (cosmetic for the Hermès/MCP consumers). Re-tighten
after a paid upgrade. Rationale and measurements:
`run-seeds.sh`.

`social-velocity` fetch precedence (mirrors the relay): ScrapeCreators when
`SCRAPECREATORS_API_KEY` is set, then Reddit OAuth when `REDDIT_CLIENT_ID` +
`REDDIT_CLIENT_SECRET` are set, else the anonymous public Reddit `.json` API.
**Reddit 403s the OCI datacenter IP on the public path** (seen on first
deploy) — from the VM you need either a ScrapeCreators key (free tier) or a
free Reddit OAuth "script" app (`reddit.com/prefs/apps`, redirect uri
`http://localhost:8080`; userless token, works from any IP). Without either,
the seeder logs the 403 and retries each tick.

Not covered (relay/credential-gated, documented):
- `risk:scores:sebuf:v8` / `intelligence:military-cii:v1` → written by
  `seed-military-cii.mjs`, which requires the relay's `WS_RELAY_URL` AIS vessel
  feed, and the risk scores themselves are computed live by the Vercel edge
  scorer — not seedable from a VM. `get_hotspot_escalation` keeps serving with
  `risk:scores:sebuf:v8` in `unavailable_inputs` (flight inputs now covered).

## Operation

```bash
# 1. .env: copy the two Upstash values from Vercel
#    (worldmonitor-weneko → Settings → Environment Variables):
#    UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
# 2. Build and start just this service:
docker compose up -d --build seeds-lite

# 3. Watch the first warm-up cycle (all six seeders run once on boot):
docker logs -f seeds-lite

# 4. Verify freshness on the fork (the health problems list should lose
#    newsInsights / ucdpEvents / gdeltIntel / conflict entries after a cycle
#    or two):
curl -s "https://worldmonitor-weneko.vercel.app/api/health?compact=1" \
  | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin).get('problems',{}),indent=1))"
```

Per-seed state (`last_*` timestamps, capped `out_*.log`) lives in the
`seeds_lite_data` volume. A failed seeder is logged and retried on the next
tick; it never stops the loop or the other seeders. `docker stop` force-kills
a seed that happens to be mid-run — harmless, the next tick simply re-runs it.