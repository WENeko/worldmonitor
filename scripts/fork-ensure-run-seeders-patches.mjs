#!/usr/bin/env node
// fork-ensure-run-seeders-patches.mjs
//
// Fork-owned, idempotent re-applier for the fork patches that live inside
// scripts/run-seeders.sh. That file is synced from the upstream repo, so an
// upstream sync can silently overwrite the fork patches. This script
// guarantees they are re-applied:
//
//   - It is wired into .github/workflows/seed-upstash.yml (also fork-owned,
//     never overwritten by upstream) and runs BEFORE every seed run, so even
//     if a sync wiped the patches the very next run repairs the file in place.
//   - It is idempotent: each patch is keyed on a unique marker comment. If the
//     marker is already present, the patch is left untouched.
//   - If an insertion anchor is missing (upstream refactored run-seeders.sh),
//     the script FAILS LOUDLY instead of silently running an unpatched runner.
//
// Usage:
//   node scripts/fork-ensure-run-seeders-patches.mjs [path-to-run-seeders.sh]
// Default target: scripts/run-seeders.sh next to this file.
//
// To add a fork patch: add an entry to PATCHES below with a unique marker,
// the anchor line it inserts next to, and the exact block text.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TARGET = join(dirname(fileURLToPath(import.meta.url)), 'run-seeders.sh');
const target = process.argv[2] || DEFAULT_TARGET;

// Each patch: name, marker (unique string already present = patch applied),
// anchor (unique string the block inserts before/after), mode, block.
const PATCHES = [
  {
    name: 'consumer-prices --force (fork: no publish.ts pipeline)',
    marker: '# seed-consumer-prices.mjs is a manual-fallback seeder that refuses to run',
    anchor: '  if caps_seed "$1"; then',
    mode: 'before',
    block: `  # seed-consumer-prices.mjs is a manual-fallback seeder that refuses to run
  # without --force: its normal guard protects the authoritative consumer-
  # prices-core publish.ts pipeline (26h TTLs) from being stomped by the seed's
  # short TTLs. This fork has no publish.ts pipeline, so the seed workflow MUST
  # pass --force or the consumer-price panels stay permanently empty.
  extra_args=""
  case "$1" in
    *seed-consumer-prices.mjs) extra_args="--force" ;;
  esac

`,
  },
  {
    name: 'exclusion of heavy/monthly seeders (zone-normals + fatf)',
    marker: '# FORK PATCH (exclusion of heavy/monthly seeders from the 6h loop).',
    anchor: '# Bundle seeders self-bound per section — never wrap them in the outer cap.',
    mode: 'before',
    block: `# FORK PATCH (exclusion of heavy/monthly seeders from the 6h loop).
# climate-zone-normals re-fetches 30 years of Open-Meteo daily archive (1991–
# 2020) for ~176 zones and blows the 240s fetch-phase deadline every run
# (upstream issue #4786); fatf-listing is a MONTHLY dataset (3x/year FATF
# plenary) that loop runs waste a 53s slot on, and its source blocks GitHub
# runner IPs with HTTP 403 anyway. Neither belongs in a 6-hourly sequential
# cron on this fork. Skips are reported (not silent) so they don't look like
# crashes.
# NOTE: this file is synced from upstream — an upstream sync can overwrite this
# section. It is re-applied automatically by
# scripts/fork-ensure-run-seeders-patches.mjs (wired into
# .github/workflows/seed-upstash.yml) before every seed run.
is_monthly_heavy() {
  case "$1" in
    *seed-climate-zone-normals.mjs|*seed-fatf-listing.mjs) return 0 ;;
    *) return 1 ;;
  esac
}

`,
  },
  {
    name: 'loop skip for heavy/monthly seeders',
    marker: 'if is_monthly_heavy "$f"; then',
    anchor: '  name="$(basename "$f")"\n',
    mode: 'after',
    block: `  if is_monthly_heavy "$f"; then
    echo "→ $name ... SKIP (heavy/monthly seed not run in the 6h loop — fork exclusion)"
    skip=$((skip + 1))
    continue
  fi
`,
  },
  {
    name: 'failure diagnostic (surface real seeder error in logs)',
    marker: '# Fork diagnostic: a standalone seeder\'s failure reason',
    anchor: '    printf "FAIL (%s)\\n" "$last"\n',
    mode: 'after',
    block: `    # Fork diagnostic: a standalone seeder's failure reason (e.g. "ACLED
    # failed: HTTP 401") is printed by the seeder well before its final line,
    # but the previous capture dropped everything but $last. Surface the tail
    # so the workflow log shows the REAL cause instead of a bare FAIL.
    echo "$output" | tail -6
`,
  },
];

let src = readFileSync(target, 'utf8');
let changed = false;

for (const patch of PATCHES) {
  if (src.includes(patch.marker)) {
    console.log(`[fork-patch] ok (already applied): ${patch.name}`);
    continue;
  }
  const anchorAt = src.indexOf(patch.anchor);
  if (anchorAt === -1) {
    throw new Error(
      `[fork-patch] FAILED to apply "${patch.name}": anchor not found ` +
        `(looking for ${JSON.stringify(patch.anchor)}). Upstream likely refactored ` +
        `${target} — update scripts/fork-ensure-run-seeders-patches.mjs so the fork ` +
        `patches can be re-applied, or the seed run would silently lose fork behavior.`,
    );
  }
  const insertAt = patch.mode === 'after' ? anchorAt + patch.anchor.length : anchorAt;
  src = src.slice(0, insertAt) + patch.block + src.slice(insertAt);
  changed = true;
  console.log(`[fork-patch] applied: ${patch.name}`);
}

if (changed) {
  // Validate before writing: a broken runner is worse than a loud failure.
  const tmp = `${target}.fork-check`;
  writeFileSync(tmp, src);
  try {
    execFileSync('sh', ['-n', tmp], { stdio: 'inherit' });
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
  }
  writeFileSync(target, src);
  console.log(`[fork-patch] wrote ${target} (validated with sh -n)`);
} else {
  console.log('[fork-patch] nothing to do — all fork patches present.');
}
