#!/usr/bin/env node
// seed-social-velocity.mjs — keyless mini port of the relay's SocialVelocity
// loop (scripts/ais-relay.cjs) for seeds-lite on the OCI VM.
//
// Fetches Reddit hot listings (r/worldnews, r/geopolitics), computes the same
// velocity score as the relay, and writes the canonical envelope + seed-meta
// that the fork's Vercel MCP tool get_social_velocity and /api/health read.
//
// Contract mirrored from scripts/ais-relay.cjs (source of truth):
//   - key  : intelligence:social:reddit:v1  (seed envelope, TTL 43200)
//   - meta : seed-meta:intelligence:social-reddit (TTL 604800)
//   - payload: { posts: [...], fetchedAt }  — posts carry id, title,
//     subreddit, url, score, upvoteRatio, numComments, velocityScore, createdAt
//   - cadence: 3h (same as the relay; Reddit rate-limits datacenter IPs under
//     faster polling — see the relay comment for the 2026-04-16 incident)
//
// Self-contained on purpose: this file lives under deploy/oci (fork-owned,
// outside the upstream-synced tree) and uses only Node builtins, so it cannot
// collide with upstream syncs or add npm dependencies to the image.
//
// Required env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const DATA_KEY = 'intelligence:social:reddit:v1';
const META_KEY = 'seed-meta:intelligence:social-reddit';
const DATA_TTL = 43200; // 12h — strictly > health maxStaleMin=540min (see relay comment)
const META_TTL = 604800; // 7d

const SUBREDDITS = ['worldnews', 'geopolitics'];
const LIMIT = 25;
const TOP = 30;

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

function fail(msg) {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

if (!REDIS_URL || !REDIS_TOKEN) {
  fail('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}

// Upstash REST: POST / with a Redis command array. Mirrors relay upstashSet().
async function redisCommand(cmdArray) {
  const resp = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmdArray),
    signal: AbortSignal.timeout(8000),
  });
  const parsed = await resp.json().catch(() => ({}));
  return parsed?.result === 'OK';
}

async function redisSet(key, value, ttlSeconds) {
  return redisCommand(['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]);
}

async function fetchSubredditHot(sub, attempt) {
  const host = attempt === 0 ? 'www.reddit.com' : 'old.reddit.com';
  const url = `https://${host}/r/${sub}/hot.json?limit=${LIMIT}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`r/${sub} HTTP ${resp.status} (${host})`);
  const json = await resp.json();
  return (json?.data?.children || []).map((c) => c?.data).filter(Boolean);
}

async function writeFailureMeta(reason) {
  await redisSet(META_KEY, {
    fetchedAt: Date.now(),
    recordCount: 0,
    sourceVersion: 'social-reddit',
    status: 'error',
    errorReason: String(reason || 'unknown').replace(/\s+/g, ' ').slice(0, 240),
  }, META_TTL);
}

async function main() {
  const nowSec = Date.now() / 1000;
  const allPosts = [];
  const seenUrls = new Set();
  const failures = [];

  for (const sub of SUBREDDITS) {
    await new Promise((r) => setTimeout(r, 500));
    let posts = [];
    for (let attempt = 0; attempt < 2 && posts.length === 0; attempt++) {
      try {
        posts = await fetchSubredditHot(sub, attempt);
      } catch (err) {
        if (attempt === 1) failures.push(`r/${sub}: ${err.message}`);
      }
    }
    if (posts.length === 0 && failures.length === 0) {
      failures.push(`r/${sub}: empty listing`);
    }
    for (const p of posts) {
      // Deduplicate cross-subreddit reposts of the same article URL.
      const articleUrl = p.url || '';
      const isExternal = articleUrl && !articleUrl.includes('reddit.com');
      if (isExternal) {
        if (seenUrls.has(articleUrl)) continue;
        seenUrls.add(articleUrl);
      }
      const ageSec = Math.max(1, nowSec - (p.created_utc || nowSec));
      const velocityScore =
        Math.log1p(p.score || 1) * (p.upvote_ratio || 0.5) * Math.exp(-ageSec / (6 * 3600)) * 100;
      allPosts.push({
        id: String(p.id || ''),
        title: String(p.title || '').slice(0, 300),
        subreddit: sub,
        url: `https://reddit.com${p.permalink || ''}`,
        score: p.score || 0,
        upvoteRatio: p.upvote_ratio || 0,
        numComments: p.num_comments || 0,
        velocityScore: Math.round(velocityScore * 10) / 10,
        createdAt: Math.round((p.created_utc || nowSec) * 1000),
      });
    }
  }

  if (allPosts.length === 0) {
    console.warn(
      `[social-velocity] No posts (${failures.join('; ') || 'unknown'}) — extending TTL, retrying next tick`,
    );
    // Preserve last-good data if a previous healthy payload exists (relay parity).
    try {
      await redisCommand(['EXPIRE', DATA_KEY, String(DATA_TTL)]);
    } catch {}
    await writeFailureMeta(failures.join('; ') || 'empty_reddit_response');
    return;
  }

  allPosts.sort((a, b) => b.velocityScore - a.velocityScore);
  const top = allPosts.slice(0, TOP);
  const fetchedAt = Date.now();
  const envelope = {
    _seed: {
      fetchedAt,
      recordCount: top.length,
      sourceVersion: 'social-reddit',
      schemaVersion: 1,
      state: 'OK',
    },
    data: { posts: top, fetchedAt },
  };

  const ok = await redisSet(DATA_KEY, envelope, DATA_TTL);
  if (!ok) {
    console.error('[social-velocity] Canonical write failed — marking seed-meta error');
    await writeFailureMeta('canonical_write_failed');
    return;
  }
  const metaOk = await redisSet(META_KEY, {
    fetchedAt,
    recordCount: top.length,
    sourceVersion: 'social-reddit',
    status: 'ok',
  }, META_TTL);
  console.log(
    `[social-velocity] Seeded ${top.length} posts from ${SUBREDDITS.join(', ')} ` +
      `(redis: ${ok ? 'OK' : 'FAIL'}, meta: ${metaOk ? 'OK' : 'FAIL'})`,
  );
}

main().catch(async (err) => {
  console.error('[social-velocity] Seed error:', err?.message || err);
  await writeFailureMeta(`seed_error: ${err?.message || err}`).catch(() => {});
});
