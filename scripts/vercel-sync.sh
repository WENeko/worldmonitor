#!/bin/bash
# Regenerate the 'vercel' deploy branch from 'main'.
#
# The fork keeps 'main' as the branch you merge upstream (koala73/worldmonitor)
# into, and generates 'vercel' as the branch Vercel actually deploys. Vercel
# discovers api/** functions before the build command runs, so the single-
# function consolidation has to be committed on the deployed branch — that is
# what prepare:vercel --force produces here.
#
# Usage (from the repo root):
#   sh scripts/vercel-sync.sh
#
# One-time setup:
#   git remote add upstream https://github.com/koala73/worldmonitor.git
set -euo pipefail
cd "$(dirname "$0")/.."

if git remote | grep -qx '^upstream$'; then
  git fetch upstream main
  git checkout main
  if ! git merge --ff-only upstream/main; then
    echo "main is not a fast-forward of upstream/main; merge upstream into main manually first." >&2
    exit 1
  fi
else
  echo "note: no 'upstream' remote configured; regenerating from current main" >&2
  git checkout main
fi

# Rebuild the deploy branch from a clean main tree, then commit the transform.
git checkout -B vercel main
node scripts/prepare-vercel.mjs --force

# The consolidation is now committed, so Vercel just runs the upstream build.
node -e "
const fs = require('fs');
const p = 'vercel.json';
const s = fs.readFileSync(p, 'utf8').replace(
  /\"buildCommand\":\s*\"[^\"]*\"/,
  '\"buildCommand\": \"npm run build:full\"'
);
fs.writeFileSync(p, s);
"

git add -A
git commit -m "deploy: regenerate vercel branch from main" || echo "no changes to commit"
git push -f origin vercel
git checkout main
echo "vercel branch regenerated and pushed"
