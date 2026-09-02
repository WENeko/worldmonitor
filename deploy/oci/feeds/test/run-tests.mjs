#!/usr/bin/env node
// Offline test harness for feed-intel (deploy/oci/feeds).
//
// Builds temp RSS / Atom / HTML fixtures with FRESH timestamps (so the suite
// never goes stale against the 72h cache prune), runs the poller --once twice
// (exercise RSS + Atom parsers + both scrape adapters + dedupe across runs)
// against a file:// catalog, then asserts the per-sector snapshots and the
// per-source health file. No network, no npm deps.
//
// Run from the repo root:  node deploy/oci/feeds/test/run-tests.mjs

import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const FEEDS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const POLLER = path.join(FEEDS_DIR, 'poll-feeds.mjs');

const pad = (n) => String(n).padStart(2, '0');
const utcDate = (d) => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;

// ── fixture builders ────────────────────────────────────────────────────────
function buildRss(items) {
  // items: [{ title, ageMin }]  →  RSS 2.0 with CDATA title + entities
  const now = Date.now();
  const out = items.map((it, i) => {
    const t = new Date(now - it.ageMin * 60_000).toUTCString();
    return `    <item>
      <title><![CDATA[${it.title} &amp; more]]></title>
      <link>https://example.org/news/${i}</link>
      <guid isPermaLink="false">guid-${i}-${it.ageMin}</guid>
      <pubDate>${t}</pubDate>
      <description>&lt;p&gt;Summary ${i}&lt;/p&gt;</description>
    </item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>BBC Sample</title>${out ? '\n' + out : ''}
</channel></rss>`;
}

function buildAtom(items) {
  const now = Date.now();
  const out = items.map((it, i) => {
    const t = new Date(now - it.ageMin * 60_000).toISOString();
    return `  <entry>
    <title>${it.title}</title>
    <link href="https://earthquake.example/event/${i}"/>
    <id>https://earthquake.example/event/${i}</id>
    <published>${t}</published>
    <summary>M ${it.ageMin} quake</summary>
  </entry>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>USGS Sample</title>
${out}
</feed>`;
}

// News-list HTML the way taiwan-mnd / pboc fixtures look: <li> with an anchor
// and a nearby date; short nav labels and junk hrefs must be filtered out.
function buildHtmlList({ date, items }) {
  const li = (href, title, withDate) =>
    `  <li>${withDate ? `<span class="date">${date}</span>` : ''}<a href="${href}">${title}</a></li>`;
  return `<!DOCTYPE html><html><head><title>Sample gov list</title></head><body>
<nav><ul><li><a href="/about/">About Us</a></li><li><a href="#">Home</a></li></ul></nav>
<ul class="news">
${items.map((it) => li(it.href, it.title, it.withDate)).join('\n')}
  <li><a href="javascript:void(0)">click bait js link that is way too long to be real</a></li>
</ul>
</body></html>`;
}

// ── run the poller once and read its outputs ───────────────────────────────
function poll(stateDir, catalogPath) {
  const res = spawnSync(process.execPath, [POLLER, '--once'], {
    cwd: FEEDS_DIR,
    env: {
      ...process.env,
      FEED_SOURCES: catalogPath,
      FEED_STATE: stateDir,
      FEED_ALLOW_FILE: '1',
      FEED_TIMEOUT_S: '5',
    },
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    console.error(res.stdout);
    console.error(res.stderr);
    throw new Error(`poller exited ${res.status}`);
  }
  return res.stdout;
}

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

async function main() {
  const work = await mkdtemp(path.join(tmpdir(), 'feed-intel-test-'));
  try {
    const now = new Date();
    const today = utcDate(now);

    // Fixtures: everything fresh (< 72h) so the cache prune keeps them.
    const rss = path.join(work, 'bbc.xml');
    const atom = path.join(work, 'usgs.atom');
    const taiwan = path.join(work, 'taiwan.html');
    const pboc = path.join(work, 'pboc.html');
    const catalog = path.join(work, 'catalog.json');
    const state = path.join(work, 'out');

    await writeFile(rss, buildRss([
      { title: 'US strikes Iran tankers under new policy', ageMin: 60 },
      { title: 'Germany blames Russia for Leipzig drone attempt', ageMin: 120 },
      { title: 'Port of Churchill ships grain to Europe again', ageMin: 180 },
    ]));
    await writeFile(atom, buildAtom([
      { title: 'M 6.1 near the Kuril Islands', ageMin: 5 },
      { title: 'M 4.8 offshore Oregon', ageMin: 45 },
    ]));
    await writeFile(taiwan, buildHtmlList({
      date: today,
      items: [
        { href: 'https://www.mnd.gov.tw/english/Press/2026/0902a.html', title: 'MND States Position on Recent PLA Activities Around Taiwan', withDate: true },
        { href: 'https://www.mnd.gov.tw/english/Press/2026/0901b.html', title: 'Defense Ministry Reaffirms Readiness Amid Regional Tensions', withDate: true },
        { href: 'https://www.mnd.gov.tw/english/Press/2026/0901c.html', title: 'Update on Military Service Policy Review', withDate: true },
        { href: 'https://www.mnd.gov.tw/english/Press/2026/0831d.html', title: 'MND Welcomes New Cohort of Reserve Officers', withDate: true },
      ],
    }));
    await writeFile(pboc, buildHtmlList({
      date: today,
      items: [
        { href: 'https://www.pbc.gov.cn/en/3688110/2026/0902.html', title: 'PBOC Conducts Medium-term Lending Facility Operations', withDate: true },
        { href: 'https://www.pbc.gov.cn/en/3688110/2026/0901.html', title: 'Governor Discusses Financial Stability at Annual Forum', withDate: true },
      ],
    }));

    const file = (p) => pathToFileURL(p).href;
    await writeFile(catalog, JSON.stringify({
      sources: [
        { id: 'bbc-test', name: 'BBC (fixture)', type: 'rss', url: file(rss), domains: ['news'], lang: 'en', reliability: 0.85, state: 'active', pollIntervalS: 60 },
        { id: 'usgs-test', name: 'USGS (fixture)', type: 'atom', url: file(atom), domains: ['environment'], lang: 'en', reliability: 0.95, state: 'active', pollIntervalS: 60 },
        { id: 'taiwan-test', name: 'Taiwan MND (fixture)', type: 'scrape', url: file(taiwan), scrape: { adapter: 'taiwan-mnd', maxItems: 10 }, domains: ['china', 'military'], lang: 'en', reliability: 0.6, state: 'active', pollIntervalS: 60 },
        { id: 'pboc-test', name: 'PBoC (fixture)', type: 'scrape', url: file(pboc), scrape: { adapter: 'pboc', maxItems: 10 }, domains: ['china', 'finance'], lang: 'en', reliability: 0.7, state: 'active', pollIntervalS: 60 },
      ],
    }));

    // ── run 1: full fetch ──
    poll(state, catalog);
    const latest1 = await readJson(path.join(state, 'latest.json'));
    const status1 = await readJson(path.join(state, 'status.json'));

    assert.equal(latest1.count, 11, 'latest.json should merge 3+2+4+2 = 11 items');

    const sectors = {};
    for (const f of ['feed-news.json', 'feed-environment.json', 'feed-china.json', 'feed-military.json', 'feed-finance.json']) {
      sectors[f] = await readJson(path.join(state, f));
    }
    assert.equal(sectors['feed-news.json'].count, 3);
    assert.equal(sectors['feed-environment.json'].count, 2);
    assert.equal(sectors['feed-china.json'].count, 6); // taiwan 4 + pboc 2
    assert.equal(sectors['feed-military.json'].count, 4);
    assert.equal(sectors['feed-finance.json'].count, 2);

    // Chinese-script-free sanity: titles present, URLs absolute http.
    const taiwanItems = sectors['feed-military.json'].items;
    assert.ok(taiwanItems.every((i) => /^https:\/\//.test(i.url)), 'scraped links must be absolute');
    assert.ok(taiwanItems.some((i) => i.title.startsWith('MND States')), 'adapter must keep long real titles');
    assert.ok(taiwanItems.every((i) => !/click bait|About Us/.test(i.title)), 'nav/junk anchors must be filtered');

    // RSS CDATA/entity decode + order (newest first).
    const newsItems = sectors['feed-news.json'].items;
    assert.equal(newsItems[0].title, 'US strikes Iran tankers under new policy & more');
    assert.equal(newsItems.length, 3);
    assert.ok(newsItems[0].publishedMs >= newsItems[1].publishedMs, 'items sorted newest first');

    // Health: all 4 sources ok, no errors, via tags recorded.
    assert.equal(Object.keys(status1.sources).length, 4);
    for (const s of Object.values(status1.sources)) {
      assert.ok(s.ok >= 1, `${s.sourceId}: expected ok>=1`);
      assert.equal(s.lastError, null, `${s.sourceId}: unexpected error ${s.lastError}`);
    }
    assert.equal(status1.sources['taiwan-test'].via, 'scrape:taiwan-mnd');
    assert.equal(status1.sources['taiwan-test'].items, 4);
    assert.equal(status1.sources['pboc-test'].items, 2);

    // ── archive: append-only SQLite history ──
    // (node:sqlite is bundled with Node 22.5+; the Docker image is node:24.)
    const { DatabaseSync } = await import('node:sqlite');
    const archivePath = path.join(state, 'archive.sqlite');
    const archive = new DatabaseSync(archivePath);
    const countItems = () => archive.prepare('SELECT COUNT(*) AS n FROM items').get().n;
    const countPolls = () => archive.prepare('SELECT COUNT(*) AS n FROM polls').get().n;
    assert.equal(countItems(), 11, 'archive must hold 11 first-seen items after run 1');
    assert.equal(countPolls(), 4, 'archive must hold 1 poll row per source (4 sources)');
    const firstSeen = archive.prepare('SELECT first_seen_at, fingerprint FROM items LIMIT 1').get();
    assert.ok(firstSeen.first_seen_at, 'first_seen_at must be populated');
    assert.ok(firstSeen.fingerprint.includes('::'), 'fingerprint must be <sourceId>::<itemId>');
    const srcStats = archive.prepare('SELECT source_id, COUNT(*) AS n FROM items GROUP BY source_id ORDER BY source_id').all();
    assert.deepEqual(srcStats.map((r) => [r.source_id, r.n]), [
      ['bbc-test', 3], ['pboc-test', 2], ['taiwan-test', 4], ['usgs-test', 2],
    ], 'archive rows must be partitioned per source');

    // ── run 2: dedupe — same items, zero new ──
    poll(state, catalog);
    const latest2 = await readJson(path.join(state, 'latest.json'));
    assert.equal(latest2.count, 11, 'second run must not duplicate items');
    const status2 = await readJson(path.join(state, 'status.json'));
    for (const s of Object.values(status2.sources)) assert.equal(s.lastError, null);
    assert.equal(countItems(), 11, 'archive must be append-only: re-polling must not duplicate rows');
    assert.equal(countPolls(), 8, 'archive must record every poll (4 sources × 2 runs)');
    archive.close();

    const manifest = await readJson(path.join(state, 'manifest.json'));
    const sectorCount = Object.keys(manifest.sectors).length;
    assert.equal(sectorCount, 5, 'expected 5 sector snapshots (news, environment, china, military, finance)');
    assert.equal(manifest.total, 11);

    console.log('feed-intel offline tests OK — 11 items across 5 sector snapshots, dedupe stable, 4 sources healthy, SQLite archive verified');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`feed-intel tests FAILED: ${err.message}`);
  process.exit(1);
});
