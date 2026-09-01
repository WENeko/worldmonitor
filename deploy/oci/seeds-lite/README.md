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
| `insights` | 15 min | `seed-insights.mjs` | `newsInsights` → `get_world_brief`, `get_news_intelligence` (headlines-only without `OPENROUTER_API_KEY`, LLM-enriched with it) |
| `ucdp` | 15 min | `seed-ucdp-events.mjs` | `ucdpEvents` (+ bootstrap) |
| `conflict` | 15 min | `seed-conflict-intel.mjs` | `acledIntel` via HAPI HDX (ACLED-derived, open), GDELT conflict feed, humanitarian keys |
| `gdelt-bulk` | 30 min | `seed-gdelt-bulk-materializer.mjs` | `gdeltIntel` (the production producer since #5843) |

Not covered in v1 (relay/credential-gated, documented):
- `get_social_velocity` → `intelligence:social:reddit:v1`, written only by the
  `ais-relay.cjs` ingestion daemon — mini-development, out of scope.
- `risk:scores:sebuf:v8` / `military:flights:v1` → written by
  `seed-military-cii.mjs`, which requires the relay's `WS_RELAY_URL` feed —
  `get_hotspot_escalation` keeps serving with `unavailable_inputs` for those.

## Operation

```bash
# 1. .env: copy the two Upstash values from Vercel
#    (worldmonitor-weneko → Settings → Environment Variables):
#    UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
# 2. Build and start just this service:
docker compose up -d --build seeds-lite

# 3. Watch the first warm-up cycle (all four seeders run once on boot):
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