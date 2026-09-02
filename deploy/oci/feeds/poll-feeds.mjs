#!/usr/bin/env node
// poll-feeds.mjs — feed-intel poller for the Hermès Macro Director layer.
//
// Fork-owned (deploy/oci), self-contained: Node builtins only, no npm deps.
// Reads an editable catalog (sources.json), fetches each active source
// (RSS 2.0 / Atom via a small dependency-free parser, or a scrape adapter),
// normalizes items, dedupes across runs, and writes per-sector snapshots +
// a per-source health/status file that Hermès uses to learn reliability.
//
// Catalog contract (see sources.json header):
//   id, name, type: rss|atom|scrape, url, domains[], lang, reliability,
//   state: active|disabled, pollIntervalS, scrape?: {adapter, ...}
//
// Outputs (state dir):
//   cache.json        rolling per-source item cache (dedupe source of truth)
//   feed-<sector>.json  merged items per sector, newest first
//   latest.json       global newest-first merge (all sectors)
//   status.json       per-source health (for reliability learning)
//
// Usage:
//   node poll-feeds.mjs --once                 single cycle, then exit
//   node poll-feeds.mjs --loop                 cycle forever (default tick 60s)
//   node poll-feeds.mjs --check                fetch once, print health, exit
//
// Env:
//   FEED_SOURCES   catalog path      (default: ./sources.json)
//   FEED_STATE     state dir         (default: ./out)
//   FEED_POLL_S    loop tick seconds (default: 60)
//   FEED_TIMEOUT_S per-fetch timeout (default: 20)
//   FEED_ALLOW_FILE=1  allow file:// URLs (offline tests only)

import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openArchive, archiveNewItems, archivePoll, archiveStats, DEFAULT_ARCHIVE_PATH } from './archive.mjs';

const SOURCES_PATH = process.env.FEED_SOURCES || path.resolve('sources.json');
const STATE_DIR = process.env.FEED_STATE || path.resolve('out');
const ARCHIVE_PATH = process.env.FEED_ARCHIVE_DB || DEFAULT_ARCHIVE_PATH(STATE_DIR);
const POLL_TICK_S = Number(process.env.FEED_POLL_S || 60);
const FETCH_TIMEOUT_S = Number(process.env.FEED_TIMEOUT_S || 20);
const ALLOW_FILE = process.env.FEED_ALLOW_FILE === '1';
const USER_AGENT = 'feed-intel/1.0 (+Hermes Macro Director; contact: operator)';
const SECTOR_CAP = 100; // max items per sector snapshot
const GLOBAL_CAP = 300;
const MAX_ITEMS_PER_SOURCE = 400; // rolling cache ceiling per source
const MAX_ITEM_AGE_S = 3 * 24 * 3600; // drop items older than 72h from cache

// ─────────────────────────── XML helpers ───────────────────────────
// Minimal, dependency-free RSS/Atom extraction. Deliberately narrow: we only
// need item/entry title, link, id/guid, dates and summary — not a full XML
// tree. CDATA and the common entities are handled; exotic namespaces are
// tolerated by treating tags case-insensitively.

function decodeXml(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function stripTags(s) {
  return String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function firstMatch(re, text) {
  const m = text.match(re);
  return m ? decodeXml(m[1]).trim() : null;
}

function firstAttr(re, text) {
  const m = text.match(re);
  return m ? decodeXml(m[1]).trim() : null;
}

// Feed-type detection from raw XML.
function detectFeedType(xml) {
  const head = xml.slice(0, 2000);
  if (/<rss[\s>]/i.test(head)) return 'rss';
  if (/<feed[\s>]/i.test(head)) return 'atom';
  return null;
}

function parseDate(raw) {
  if (!raw) return null;
  const ts = Date.parse(decodeXml(raw));
  return Number.isFinite(ts) ? ts : null;
}

function parseRssItems(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  return blocks.map((b) => {
    const title = stripTags(firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i, b)) || null;
    const link = firstMatch(/<link[^>]*>([\s\S]*?)<\/link>/i, b)
      || firstAttr(/<link[^>]*href=["']([^"']+)["']/i, b);
    const id = firstMatch(/<guid[^>]*>([\s\S]*?)<\/guid>/i, b)
      || firstMatch(/<guid[^>]*isPermaLink=["']false["'][^>]*>([\s\S]*?)<\/guid>/i, b)
      || link;
    const published = parseDate(firstMatch(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i, b));
    const summary = stripTags(firstMatch(/<description[^>]*>([\s\S]*?)<\/description>/i, b)) || null;
    return { title, link, id, published, summary };
  });
}

function parseAtomItems(xml) {
  const blocks = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    const title = stripTags(firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i, b)) || null;
    const link = firstAttr(/<link[^>]*href=["']([^"']+)["']/i, b);
    const id = firstMatch(/<id[^>]*>([\s\S]*?)<\/id>/i, b) || link;
    const published = parseDate(
      firstMatch(/<published[^>]*>([\s\S]*?)<\/published>/i, b)
      || firstMatch(/<updated[^>]*>([\s\S]*?)<\/updated>/i, b),
    );
    const summary = stripTags(firstMatch(/<summary[^>]*>([\s\S]*?)<\/summary>/i, b)) || null;
    return { title, link, id, published, summary };
  });
}

function parseFeed(xml) {
  const type = detectFeedType(xml);
  if (type === 'rss') return { type, items: parseRssItems(xml) };
  if (type === 'atom') return { type, items: parseAtomItems(xml) };
  return { type: null, items: [] };
}

// ─────────────────────────── fetch helpers ───────────────────────────
async function loadSourceText(url) {
  if (url.startsWith('file://')) {
    if (!ALLOW_FILE) throw new Error('file:// URLs disabled (set FEED_ALLOW_FILE=1 for offline tests)');
    return readFile(new URL(url), 'utf8');
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_S * 1000);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      signal: ac.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  } finally {
    clearTimeout(t);
  }
}

// ─────────────────────────── catalog & adapters ───────────────────────────
async function loadCatalog() {
  const raw = JSON.parse(await readFile(SOURCES_PATH, 'utf8'));
  if (!Array.isArray(raw.sources)) throw new Error(`catalog ${SOURCES_PATH}: missing "sources" array`);
  return raw.sources;
}

async function loadAdapters() {
  const adapters = new Map();
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'adapters');
  let entries;
  try { entries = await readdir(dir); } catch { return adapters; }
  for (const e of entries) {
    if (!e.endsWith('.mjs')) continue;
    const stem = e.slice(0, -4); // adapter id = file stem: "taiwan-mnd.mjs" -> "taiwan-mnd"
    const mod = await import(path.join(dir, e));
    if (mod && typeof mod.default === 'function') adapters.set(stem, mod.default);
  }
  return adapters;
}

// ─────────────────────────── archive (append-only history) ───────────
// Lazy singleton: opened once on first use, never re-opened per cycle. If the
// open fails (no node:sqlite on an exotic runtime), the poller keeps running
// without history.
let archiveDb = null;
let archiveInit = false;

async function getArchive() {
  if (!archiveInit) {
    archiveInit = true;
    archiveDb = await openArchive(ARCHIVE_PATH);
  }
  return archiveDb;
}

// ─────────────────────────── state store ───────────────────────────
async function loadCache() {
  try {
    return JSON.parse(await readFile(path.join(STATE_DIR, 'cache.json'), 'utf8'));
  } catch { return {}; }
}

async function saveCache(cache) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(path.join(STATE_DIR, 'cache.json'), JSON.stringify(cache));
}

async function loadStatus() {
  try {
    const raw = JSON.parse(await readFile(path.join(STATE_DIR, 'status.json'), 'utf8'));
    // status.json stores { generatedAt, sources: {...} }; accept a legacy bare map too.
    return raw && typeof raw === 'object' && raw.sources ? raw.sources : raw;
  } catch { return {}; }
}

async function writeJson(name, obj) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(path.join(STATE_DIR, name), JSON.stringify(obj, null, 2));
}

// ─────────────────────────── poll one source ───────────────────────────
async function pollSource(src, adapters, status) {
  const st = status[src.id] || (status[src.id] = { sourceId: src.id, name: src.name, ok: 0, fail: 0, lastOkAt: null, lastError: null, items: 0, lastItemAt: null });
  const now = Date.now();
  try {
    let text;
    let via = src.type;
    if (src.type === 'scrape') {
      const adapter = adapters.get(src.scrape?.adapter);
      if (!adapter) throw new Error(`scrape adapter "${src.scrape?.adapter}" not found in adapters/`);
      text = await adapter(src, { fetch: loadSourceText, stripTags, decodeXml });
      via = `scrape:${src.scrape.adapter}`;
    } else {
      text = await loadSourceText(src.url);
    }
    const xmlItems = typeof text === 'string' ? parseFeed(text).items : text;
    const seenIds = new Set();
    const normalized = [];
    for (const it of xmlItems) {
      const id = (it.id || it.link || '').trim();
      const link = (it.link || '').trim();
      const title = (it.title || '').trim();
      if (!id || !title || !link) continue;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      normalized.push({
        id,
        title,
        url: link,
        publishedAt: it.published ? new Date(it.published).toISOString() : null,
        publishedMs: it.published,
        summary: it.summary ? String(it.summary).slice(0, 600) : null,
        sourceId: src.id,
        sourceName: src.name,
        reliability: typeof src.reliability === 'number' ? src.reliability : null,
        lang: src.lang || null,
        sectors: Array.isArray(src.domains) ? src.domains : [],
      });
    }
    st.ok += 1;
    st.lastOkAt = new Date(now).toISOString();
    st.lastError = null;
    st.via = via;
    return normalized;
  } catch (err) {
    st.fail += 1;
    st.lastError = String(err?.message || err).slice(0, 300);
    st.lastErrorAt = new Date(now).toISOString();
    return [];
  }
}

// ─────────────────────────── merge into cache ───────────────────────────
function mergeItems(cache, src, freshItems) {
  const prev = cache[src.id]?.items || [];
  const prevIds = new Set(prev.map((i) => i.id));
  const newItems = freshItems.filter((i) => !prevIds.has(i.id));
  const merged = [...prev];
  for (const item of freshItems) {
    const idx = merged.findIndex((m) => m.id === item.id);
    if (idx >= 0) merged[idx] = item; // refresh in place (title/score drift)
    else merged.unshift(item); // brand-new item goes to the top
  }
  const cutoff = Date.now() - MAX_ITEM_AGE_S * 1000;
  const pruned = merged
    .filter((i) => !i.publishedMs || i.publishedMs >= cutoff)
    .slice(0, MAX_ITEMS_PER_SOURCE);
  cache[src.id] = { items: pruned, polledAt: new Date().toISOString() };
  return { nNew: newItems.length, newItems };
}

// ─────────────────────────── snapshots ───────────────────────────
function buildSnapshots(cache, status) {
  const bySector = new Map();
  const all = [];
  for (const [sourceId, entry] of Object.entries(cache)) {
    for (const it of entry.items) {
      const item = { ...it, sourceId };
      all.push(item);
      for (const s of it.sectors || []) {
        if (!bySector.has(s)) bySector.set(s, []);
        bySector.get(s).push(item);
      }
    }
  }
  const sortDesc = (a, b) => (b.publishedMs || 0) - (a.publishedMs || 0);
  all.sort(sortDesc);
  const sectors = {};
  for (const [s, items] of bySector) {
    items.sort(sortDesc);
    sectors[s] = { sector: s, generatedAt: new Date().toISOString(), count: items.slice(0, SECTOR_CAP).length, items: items.slice(0, SECTOR_CAP) };
  }
  const global = { generatedAt: new Date().toISOString(), count: Math.min(all.length, GLOBAL_CAP), items: all.slice(0, GLOBAL_CAP) };
  return { sectors, global };
}

async function writeSnapshots(cache, status) {
  const { sectors, global } = buildSnapshots(cache, status);
  const statusOut = {
    generatedAt: new Date().toISOString(),
    sources: status,
  };
  await writeJson('latest.json', global);
  for (const [sector, data] of Object.entries(sectors)) {
    await writeJson(`feed-${sector}.json`, data);
  }
  await writeJson('status.json', statusOut);
  await saveCache(cache);
  // touch feed-manifest for the MCP layer to know what exists
  await writeJson('manifest.json', {
    generatedAt: global.generatedAt,
    sectors: Object.fromEntries(Object.entries(sectors).map(([k, v]) => [k, v.count])),
    total: global.count,
  });
}

// ─────────────────────────── run cycle ───────────────────────────
async function runCycle(verbose = true, force = false) {
  const catalog = await loadCatalog();
  const adapters = await loadAdapters();
  const cache = await loadCache();
  const status = await loadStatus();
  const archive = await getArchive();
  const due = catalog.filter((s) => s.state === 'active');
  for (const src of due) {
    const lastPoll = cache[src.id]?.polledAt ? Date.parse(cache[src.id].polledAt) : 0;
    const interval = (src.pollIntervalS || 300) * 1000;
    const ready = force || Date.now() - lastPoll >= interval;
    if (!ready) continue;
    const fetchedAt = new Date().toISOString();
    const fresh = await pollSource(src, adapters, status);
    const { nNew, newItems } = mergeItems(cache, src, fresh);
    const st = status[src.id];
    st.items = cache[src.id]?.items?.length || 0;
    const newest = cache[src.id]?.items?.[0];
    st.lastItemAt = newest?.publishedAt || st.lastItemAt;
    // Append-only history: one row per first-seen item + one poll-stat row.
    const archived = archiveNewItems(archive, src, newItems, fetchedAt);
    archivePoll(archive, src, fresh.length, nNew, !st.lastError);
    if (verbose) {
      console.log(`[feed-intel] ${src.id} (${src.type}) → ${fresh.length} fetched, ${nNew} new (${archived} archived) | ok=${st.ok} fail=${st.fail}${st.lastError ? ` | lastError: ${st.lastError}` : ''}`);
    }
  }
  await writeSnapshots(cache, status);
  const summary = Object.values(status).filter((s) => s.fail > 0).length;
  if (verbose) {
    console.log(`[feed-intel] cycle done → ${Object.keys(cache).length} sources cached; ${summary} with failures`);
  }
  return status;
}

// ─────────────────────────── CLI ───────────────────────────
const mode = process.argv.includes('--check') ? 'check'
  : process.argv.includes('--once') ? 'once'
    : 'loop';

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  if (mode === 'check' || mode === 'once') {
    await runCycle(true, true); // force: one-shot runs poll everything

    if (mode === 'check') {
      const status = await loadStatus();
      console.log('\n── source health ──');
      for (const s of Object.values(status)) {
        console.log(`  ${s.sourceId.padEnd(22)} ok=${String(s.ok).padStart(3)} fail=${String(s.fail).padStart(3)} items=${String(s.items).padStart(4)}${s.lastError ? `  ERROR: ${s.lastError}` : ''}`);
      }
      const { items, polls } = archiveStats(await getArchive());
      console.log(`── archive ── items=${items} polls=${polls} db=${ARCHIVE_PATH}`);
    }
    return;
  }
  console.log(`[feed-intel] loop mode — catalog=${SOURCES_PATH} state=${STATE_DIR} tick=${POLL_TICK_S}s`);
  for (;;) {
    try { await runCycle(true, false); } catch (err) {
      console.error(`[feed-intel] cycle error: ${err.message}`);
    }
    await sleep(POLL_TICK_S * 1000);
  }
}

main().catch((err) => {
  console.error(`[feed-intel] fatal: ${err.message}`);
  process.exit(1);
});
