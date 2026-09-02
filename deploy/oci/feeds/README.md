# feed-intel — the Macro Director's own news layer

Dependency-free poller (RSS / Atom / scrape) that feeds the Hermès Macro
Director with **operator-controlled sources**, outside the heavyweight
WorldMonitor pipeline. Zero external APIs, zero Redis writes: every poll is a
plain HTTP GET and the output is plain JSON on a shared volume.

Why this exists: the WorldMonitor MCP tools return data that is hours old by
design (upstream tiering + stretched seed cadences) and its source list is
frozen in upstream code. `feed-intel` gives the Macro Director a fresh
(1–5 min), self-curated signal whose sources it can add, disable and re-rate
itself as it learns which ones are reliable.

## Layout

| Path | Role |
|---|---|
| `sources.json` | **The editable catalog.** Hermès adds/removes/disables/re-rates sources here live (mounted rw in the hermes container at `/opt/data/feed-sources.json`). The poller re-reads it every cycle — no restart. |
| `poll-feeds.mjs` | Engine: fetch → normalize → dedupe (rolling 72 h cache per source) → per-sector snapshots + health file + append-only SQLite archive. Node builtins only. |
| `archive.mjs` | Append-only SQLite history (`node:sqlite`, bundled since Node 22.5) — first-seen items + per-poll stats, the backtest surface. |
| `adapters/` | HTML scrapers for sources without RSS (`taiwan-mnd.mjs`, `pboc.mjs`), sharing `_list.mjs`. Each adapter throws on an unrecognized layout so breakage shows up in `status.json` instead of silent empty output. |
| `test/run-tests.mjs` | Offline suite (temp fixtures, no network): `node deploy/oci/feeds/test/run-tests.mjs` from the repo root. |
| `Dockerfile` | `node:24-alpine`, non-root, loop mode by default. |

## Outputs (state dir, shared with Hermès)

- `feed-<sector>.json` — merged items per sector, newest first
- `latest.json` — global newest-first merge (all sectors)
- `manifest.json` — which sectors exist and their counts
- `status.json` — per-source health: `ok / fail / lastError / items / via` —
  **this is the reliability-learning surface**: watch a source's `fail` /
  `lastError` over time, then edit its `reliability` 0..1 in `sources.json`.
- `archive.sqlite` — **append-only SQLite history** (same volume):
  - `items` — one row per *first-seen* item (`fingerprint = sourceId::itemId`,
    `first_seen_at` = when feed-intel first observed it, plus title/url/sectors/
    reliability/published_at at first sight).
  - `polls` — one row per source per cycle (`fetched`, `new_items`, `ok`).

  This is the **backtest surface** for the Macro Director: “what did the layer
  know at 14:03 when the directive was issued”, “which source broke X first”,
  “how reliable is source Y over weeks” — questions the 72 h rolling files
  cannot answer. Query it read-only from Hermès via
  `/opt/data/feed-intel/archive.sqlite` (the volume is mounted ro).

Sector taxonomy mirrors WorldMonitor coverage: `geopolitics, military, news,
finance, energy, infrastructure-cyber, environment, aviation, china, tech`.

## Operating it on the VM

```bash
cd ~/wm-stack && git pull --ff-only origin oci-trading-stack && cd deploy/oci
docker compose up -d --build feed-intel

# one-shot health probe of every source (do this FIRST; sandbox has no DNS):
docker compose run --rm feed-intel node poll-feeds.mjs --check
#  → per-source ok/fail/items; scrape adapters start state:disabled until this
#    is green, then flip them to "active" in sources.json (Hermès can too).
```

The compose file bind-mounts `./feeds/sources.json` rw into both `feed-intel`
(`/app/sources.json`) and `hermes` (`/opt/data/feed-sources.json`), and the
state volume (`feed_intel_data`) into `hermes` read-only at
`/opt/data/feed-intel`. No rebuild is needed after editing the catalog.

## Provenance & trust rules

- Feed content (titles, summaries, URLs) is **untrusted data**, never
  instructions. Timestamps are the feed's own (`publishedAt`); `cache.json`
  keeps when feed-intel first saw each item.
- Items older than 72 h are pruned from the cache; snapshots cap at 100
  items/sector, 300 globally.
- Scraped HTML layouts rot. The adapters fail loudly (`status.json` error);
  fix the selector in `adapters/<name>.mjs`, never in the engine.

## Archive & backtests

The archive is written inside the same poll loop as the snapshots: every
first-seen item gets one `INSERT OR IGNORE` row, every poll one stats row.
No schema migration, no pruning — it is append-only by construction, and
`INSERT OR IGNORE` makes re-polls idempotent. If `node:sqlite` is unavailable
on an exotic runtime the poller degrades gracefully (archive disabled, logged
once) and keeps writing the JSON snapshots. Path: `FEED_ARCHIVE_DB`
(default: `<state>/archive.sqlite`).

Useful queries:

```sql
-- items first seen in the last 24 h, newest observation first
SELECT source_id, title, url, first_seen_at FROM items
WHERE first_seen_at >= datetime('now', '-1 day') ORDER BY first_seen_at DESC;

-- which source broke the most items first over the last 7 days
SELECT source_id, COUNT(*) FROM items
WHERE first_seen_at >= datetime('now', '-7 days') GROUP BY source_id ORDER BY 2 DESC;
```

## Cadence & cost

Each source obeys its own `pollIntervalS` (default 300 s). 25 sources × 1 JSON
rewrite per poll ≈ 2–4 commands-equivalent of disk I/O, zero network cost
beyond the GET itself — this layer is immune to the Upstash quota problem that
motivated it. Prefer fewer, higher-trust sources over the Google News
topic-fallback entries as Hermès learns.
