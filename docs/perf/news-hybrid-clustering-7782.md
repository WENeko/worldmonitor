# Hybrid clustering measurement — 2026-09-06 (#7782)

Wave 3 study item 7. Measurement gate: move the initial synchronous Jaccard
stage of `clusterNewsHybrid` onto the existing analysis worker only if that
stage causes a repeatable long task (>50 ms) or frame-budget miss (≥16.7 ms).
Missing representative data is an unmet gate, not a pass.

**Decision: stop without moving the work.** The production digest and the
deterministic high-diversity case stay under both budgets, including a 6× CPU
throttle on Chromium. Worker round trips do not reduce main-thread occupancy
enough to justify the existing worker's 10 s ready timeout, 30 s request
timeout, empty-on-unsupported-construction path, or serialization cost.

## How to measure

Capture the public full-English digest (follow the `www` redirect; `public=1`
is required):

```bash
curl -fsSL -A "WorldMonitor-agent/7782" \
  -o tmp/list-feed-digest.full.en.json \
  "https://www.worldmonitor.app/api/news/v1/list-feed-digest?variant=full&lang=en&public=1"
```

Node core timings (same `clusterNewsCore` as the dashboard):

```bash
node scripts/profile-news-hybrid-clustering-7782.mjs tmp/list-feed-digest.full.en.json
```

Chromium + production minify + CDP CPU throttle, using the committed fixture:

```bash
node scripts/profile-news-hybrid-clustering-7782-browser.mjs \
  docs/perf/news-hybrid-clustering-7782.fixture.json
```

The high-diversity case is generated in-process: 1,500 unique-token titles,
which the shared core then caps at `MAX_CLUSTER_NEWS_ITEMS` (1,000).

## Fixture

Committed snapshot: [news-hybrid-clustering-7782.fixture.json](./news-hybrid-clustering-7782.fixture.json).

| Field | Value |
|---|---|
| Captured | 2026-09-06T10:49:06.337Z |
| URL | `https://www.worldmonitor.app/api/news/v1/list-feed-digest?variant=full&lang=en&public=1` |
| Items (concatenated categories, matching `ctx.allNews`) | 289 |
| Unique links | 269 |
| Clusters | 255 (225 singleton, 30 multi-source) |
| Unique sources | 110 |
| Date span | 2026-09-02T12:14:35Z → 2026-09-06T10:32:05Z (94.3 h) |
| Recency | 36 in 0–1 h, 51 in 1–6 h, 110 in 6–24 h, 78 in 1–3 d, 14 older |

Category counts are 20 for most buckets, 0 for `crisis`, and 10–15 for
`commodities` / `energy` / `ai` / `layoffs`. Intel is already a digest
category (20 items). On web, per-feed fallback is off, so this is the
clustering input the dashboard actually sees. The 1,000-item cap is not
reached.

A previous public capture that returned HTTP 403 used `worldmonitor.app`
without following the Cloudflare 301 to `www.worldmonitor.app`.

## Host

| Field | Value |
|---|---|
| Device | Apple M5 Max, 18 cores, 36 GB, Darwin arm64 |
| Node | v24.20.0 |
| Browser | Playwright Chromium, headless |
| Build | esbuild `--minify` IIFE of `shared/news-clustering-core.js` |
| Throttle | CDP `Emulation.setCPUThrottlingRate` 1 / 4 / 6 |

Six-times throttle is the documented mid-tier approximation used by
`scripts/measure-dashboard-render-axis.mjs`. Absolute milliseconds are
host-local; the pass/fail signal is whether the isolated Jaccard call
crosses 16.7 ms or 50 ms.

## Chromium results (9 samples after one warmup)

Representative production fixture (289 items → 255 clusters), including
threat and credibility fields used by `clusterNewsCore`:

| CPU | Sync median (max) | Serialize median | Worker cold ready | Worker warm RT | Clustering long tasks | Frame miss | Long task |
|---|---|---|---|---|---|---|---|
| 1× | 2.2 ms (3.2) | 0.4 ms | 7.8 ms | 3.1 ms | 0 | no | no |
| 4× | 8.6 ms (10.6) | 1.1 ms | 4.1 ms | 3.8 ms | 0 | no | no |
| 6× | 12.0 ms (17.1) | 1.9 ms | 5.7 ms | 4.7 ms | 0 | no | no |

High-diversity 1,500 inputs (capped to 1,000 clusters, all singletons):

| CPU | Sync median (max) | Serialize median | Worker cold ready | Worker warm RT | Clustering long tasks | Frame miss | Long task |
|---|---|---|---|---|---|---|---|
| 1× | 2.3 ms (2.8) | 1.0 ms | 2.8 ms | 4.9 ms | 0 | no | no |
| 4× | 9.8 ms (11.5) | 3.3 ms | 3.6 ms | 7.2 ms | 0 | no | no |
| 6× | 14.5 ms (15.9) | 5.2 ms | 6.6 ms | 9.4 ms | 0 | no | no |

Worker round trips post and hydrate the full cluster payload, matching
`analysisWorker.clusterNews()`. The 6× representative max is 17.1 ms, but
the median is 12.0 ms and no clustering long task fired. Production input
is 289 items, not the 1,000-item cap.

An earlier unyielded harness mixed serialization loops and blob-worker
construction into the same task and reported 67 ms / 109 ms long tasks at
4×/6×. Those disappeared once clustering ran with a turn yield between
samples. They are not clustering occupancy.

## Node cross-check

Same core, no throttle. Worker numbers here are `worker_threads` process
spawns (~20 ms) and overstate browser worker cost; use the Chromium table
for worker lifecycle.

| Case | Items | Clusters | Sync median | Notes |
|---|---|---|---|---|
| Representative digest | 289 | 255 | 2.8 ms | Matches Chromium 1× |
| High-diversity 1,500 | 1,500 → 1,000 | 1,000 | 3.6 ms | Matches Chromium 1× |
| Shared-token stress 1,500 | 1,500 → 1,000 | 1,000 | 195 ms | Pathological: every title shares `Ukraine Russia China`. Not a production shape. Excluded from the gate. |

## Why the worker is not justified

`clusterNewsHybrid` calls `clusterNewsCore` before its first `await`. That
call is the only main-thread occupancy this issue may move.

- Production occupancy is 2.2 ms unthrottled and 12.0 ms median at 6×, with
  a 17.1 ms max. The median stays under a 16.7 ms frame and far under a
  50 ms long task.
- The existing analysis worker is lazy, waits up to 10 s to become ready
  and 30 s for a clustering request, and returns `[]` when construction is
  unsupported. Treating that empty result as an authoritative cluster set
  would wipe news hubs. A direct `await analysisWorker.clusterNews(...)`
  replacement would also drop the hybrid path's synchronous Jaccard
  fallback.
- Warm blob-worker round trips look faster under CDP 6× (4.7 ms vs 12.0 ms
  sync) because throttling hits the renderer main thread harder than the
  worker. On a uniformly slow device both sides share the same CPU, so that
  gap is not a measured mid-tier win. Serialization of the representative
  payload is 1.9 ms at 6× — similar order to the clustering itself at 1×,
  not a reason to add a lifecycle.

No clustering thresholds, article caps, or worker infrastructure were
changed.

## Scope left untouched

Related exact-entity / event-tree issues (#5984, #6634) are different
product work. This measurement does not migrate algorithms.

## Verification

No production clustering code changed, so the issue's implementation gates
were not required. Harnesses were executed as above.

```bash
node --test tests/profile-news-hybrid-clustering-7782.test.mjs
```

That test locks the gate helper so the shared-token stress case cannot be
treated as a go signal, and so importing the Node profiler does not launch
the full measurement run.
