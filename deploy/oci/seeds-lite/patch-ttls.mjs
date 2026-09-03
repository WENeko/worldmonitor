#!/usr/bin/env node
// patch-ttls.mjs — fork-owned build-time patch for the seeds-lite image.
//
// The seeds-lite Dockerfile copies scripts/ from the synced fork tree, and an
// upstream sync can silently revert any TTL constant we edit in place. This
// patch re-applies the fork's TTL overrides at every image build, anchoring on
// the exact upstream constant lines and FAILING the build loudly if an anchor
// is no longer found (an upstream rename must be reviewed, not silently
// skipped).
//
// Why these overrides (see run-seeds.sh for the cadence table): seeds-lite
// stretches the `conflict` and `insights` cadences hard to fit the Upstash
// free tier. Each override exists to make the stretched cadence SAFE — the
// Redis key must still exist between runs:
//
//   seed-conflict-intel.mjs
//     ACLED_TTL 2700s (45 min) — upstream cadence is every 15 min. seeds-lite
//     runs `conflict` every 3h, so 45 min would expire
//     `conflict:acled:v1:all:0:0` ~2h15m before the next run (health EMPTY
//     crit instead of STALE). 4h leaves 1h headroom.
//     PIZZINT_TTL 600s (10 min) — expires minutes after each write at a 3h
//     cadence. 4h matches the ACLED window.
//
//   seed-insights.mjs
//     CACHE_TTL 10800s (3h) — equal to the stretched insights cadence would
//     leave ZERO headroom against scheduling jitter (a slow run or a sleeping
//     VM expires `news:insights:v1` → health EMPTY crit until the next tick).
//     6h leaves 3h headroom; the fork's Hermès news layer is feed-intel
//     (1-5 min), so a world-brief up to 3h old is acceptable.
//
// Usage (in the Dockerfile, after `COPY scripts/ ./scripts/`):
//   COPY deploy/oci/seeds-lite/patch-ttls.mjs /tmp/patch-ttls.mjs
//   RUN node /tmp/patch-ttls.mjs /app/scripts && rm /tmp/patch-ttls.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SCRIPTS_DIR = resolve(process.argv[2] || '/app/scripts');

// [fork-patch] markers make the divergence visible to anyone reading the
// patched file inside the image.
const PATCHES = [
  {
    file: 'seed-conflict-intel.mjs',
    anchor: 'export const ACLED_TTL = 2700;',
    replacement:
      'export const ACLED_TTL = 14400; // 4h — [fork-patch] seeds-lite stretches `conflict` to 3h; the 2700s (45min) upstream default would expire conflict:acled:v1:all:0:0 between runs',
  },
  {
    file: 'seed-conflict-intel.mjs',
    anchor: 'const PIZZINT_TTL = 600;',
    replacement:
      'const PIZZINT_TTL = 14400; // 4h — [fork-patch] seeds-lite runs `conflict` every 3h; the 600s (10min) upstream default would expire pizzint keys minutes after each write',
  },
  {
    file: 'seed-insights.mjs',
    anchor: 'const CACHE_TTL = 10800; // 3h — 6x the 30 min cron interval. Shorter = key expires on any missed',
    replacement:
      'const CACHE_TTL = 21600; // 6h — [fork-patch] seeds-lite runs `insights` every 3h; the 10800s (3h) upstream default left zero headroom against a missed tick',
  },
];

let applied = 0;
for (const patch of PATCHES) {
  const filePath = join(SCRIPTS_DIR, patch.file);
  const source = readFileSync(filePath, 'utf8');

  if (source.includes(patch.replacement)) {
    console.log(`[fork-patch] ok (already applied): ${patch.file} — ${patch.anchor.trim()}`);
    continue;
  }
  if (!source.includes(patch.anchor)) {
    throw new Error(
      `[fork-patch] FAILED: anchor not found in ${patch.file}: "${patch.anchor}". `
      + 'Upstream moved/renamed this constant — review and update patch-ttls.mjs before rebuilding.',
    );
  }
  writeFileSync(filePath, source.replace(patch.anchor, patch.replacement), 'utf8');
  applied += 1;
  console.log(`[fork-patch] applied: ${patch.file} — ${patch.anchor.trim()}`);
}

if (applied === 0) {
  console.log('[fork-patch] nothing to do — all TTL patches already present.');
} else {
  console.log(`[fork-patch] ${applied} TTL override(s) applied.`);
}
