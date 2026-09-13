import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { newsHandler } from '../server/worldmonitor/news/v1/handler';
import { __testing__ as digest } from '../server/worldmonitor/news/v1/list-feed-digest';
import { rssFeedCacheKey } from '../server/worldmonitor/news/v1/_rss-cache';
import { REVOKED_URLS_KEY } from '../server/_shared/digest-revocations';
import { drainResponseHeaders } from '../server/_shared/response-headers';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis';
import { createNewsServiceRoutes, type ListCountryHeadlinesResponse } from '../src/generated/server/worldmonitor/news/v1/service_server';
import { validateGeneratedRequest } from '../server/request-validator';
import { selectCountryHeadlines } from '../scripts/freeze-crawlable-live-pulse.mjs';
import { briefGroundingGap } from '../scripts/crawlable-developments.mjs';

const route = createNewsServiceRoutes(newsHandler, { validateRequest: validateGeneratedRequest })
  .find(entry => entry.path.endsWith('/list-country-headlines'))!;
const envKeys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV', 'LOCAL_API_MODE', 'NEWS_MAX_AGE_HOURS'] as const;
const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const entries = digest.buildDigestFeedBatches('full', 'en').allEntries;
let cache: Map<string, unknown>;
let commands: string[][];
let revoked: string[];
let failRevocations: boolean;

function feed(name: string) {
  const found = entries.find(entry => entry.feed.name === name)?.feed;
  assert.ok(found, `${name} is a registered English digest feed`);
  return found;
}

function article(source: string, overrides: Record<string, unknown> = {}) {
  return { source, title: 'Palau approves maritime surveillance funding', link: 'https://islandtimes.org/palau-funding', publishedAt: Date.now() - 3600_000, ...overrides };
}

function put(source: string, items: unknown[]) {
  cache.set(rssFeedCacheKey('full', feed(source).url), { items });
}

async function request(codes = ['PW']) {
  const query = new URLSearchParams();
  codes.forEach(code => query.append('country_codes', code));
  const req = new Request(`https://example.test/api/news/v1/list-country-headlines?${query}`);
  const res = await route.handler(req);
  return { req, res, payload: await res.json() as ListCountryHeadlinesResponse };
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
  process.env.VERCEL_ENV = 'production';
  delete process.env.LOCAL_API_MODE;
  delete process.env.NEWS_MAX_AGE_HOURS;
  __resetKeyPrefixCacheForTests();
  cache = new Map(entries.map(entry => [rssFeedCacheKey('full', entry.feed.url), { items: [] }]));
  commands = [];
  revoked = [];
  failRevocations = false;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://redis.example.test/pipeline', 'never fetch a publisher or call a generator');
    const batch = JSON.parse(String(init?.body)) as string[][];
    commands.push(...batch);
    return Response.json(batch.map(command => {
      if (command[0] === 'SMEMBERS') {
        assert.equal(command[1], REVOKED_URLS_KEY);
        return failRevocations ? { error: 'fixture read failure' } : { result: revoked };
      }
      assert.equal(command[0], 'GET', 'RSS acquisition is read-only');
      return { result: cache.has(command[1]) ? JSON.stringify(cache.get(command[1])) : null };
    }));
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (oldEnv[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnv[key];
  }
  __resetKeyPrefixCacheForTests();
});

describe('country headlines from existing curated RSS caches', () => {
  it('carries a parsed regional article through the registered RPC into country grounding', async () => {
    const source = feed('Guardian Pacific');
    const publishedAt = new Date(Date.now() - 3600_000).toUTCString();
    const xml = `<rss><channel><item><title>Vanuatu ferry search continues</title><link>https://www.theguardian.com/world/vanuatu-search</link><pubDate>${publishedAt}</pubDate></item></channel></rss>`;
    const parsed = digest.parseRssXml(xml, source, 'full');
    assert.ok(parsed);
    cache.set(rssFeedCacheKey('full', source.url), parsed);
    const { payload, res } = await request(['vu', 'PW', 'vu']);
    assert.equal(res.status, 200);
    assert.equal(payload.state, 'complete');
    assert.equal(payload.feedCached, payload.feedTotal);
    assert.deepEqual(Object.keys(payload.countries), ['VU']);
    const rows = selectCountryHeadlines(payload.countries.VU.items, 'VU');
    assert.equal(rows[0].source, 'Guardian Pacific');
    assert.equal(rows[0].publishedAt, new Date(publishedAt).toISOString());
    assert.equal(briefGroundingGap(rows), 'thin-grounding');
    assert.ok(commands.some(command => command[1] === rssFeedCacheKey('full', source.url)));
  });

  it('rejects stale, undated, future, malformed, wrong-country and revoked rows', async () => {
    const name = 'Island Times (Palau)';
    const rows = [
      article(name),
      article(name, { link: 'https://islandtimes.org/revoked' }),
      article(name, { publishedAt: Date.now() - 97 * 3600_000, link: 'https://islandtimes.org/stale' }),
      article(name, { publishedAt: 0, link: 'https://islandtimes.org/undated' }),
      article(name, { publishedAt: Date.now() + 2 * 3600_000, link: 'https://islandtimes.org/future' }),
      article(name, { publishedAt: '2026-09-13', link: 'https://islandtimes.org/string-date' }),
      article(name, { title: 'African Union (AU) meets', link: 'https://islandtimes.org/au' }),
      article(name, { title: 'Palau **breaking** news', link: 'https://islandtimes.org/bold' }),
      article(name, { source: 'Unregistered publisher', link: 'https://islandtimes.org/unknown-source' }),
      article(name, { link: 'javascript:alert(1)' }),
      article(name, { link: 'https://user:password@islandtimes.org/credentials' }),
      null,
      article(name),
    ];
    put(name, rows);
    revoked = ['https://islandtimes.org/revoked'];
    const { payload } = await request(['PW', 'AU']);
    assert.deepEqual(Object.keys(payload.countries), ['PW']);
    assert.deepEqual(payload.countries.PW.items, [rows[0]]);
  });

  it('uses the digest age override and its fallback for invalid configuration', async () => {
    process.env.NEWS_MAX_AGE_HOURS = '12';
    put('Island Times (Palau)', [article('Island Times (Palau)', { publishedAt: Date.now() - 13 * 3600_000 })]);
    assert.deepEqual((await request()).payload.countries, {});
    process.env.NEWS_MAX_AGE_HOURS = 'invalid';
    assert.equal((await request()).payload.countries.PW.items.length, 1);
  });

  it('reserves room for distinct publishers without counting regional desks twice', async () => {
    const guardian = Array.from({ length: 5 }, (_, i) => article('Guardian Pacific', { link: `https://www.theguardian.com/palau-${i}`, publishedAt: Date.now() - (i + 1) * 1000 }));
    put('Guardian Pacific', guardian);
    put('Guardian World', [article('Guardian World', { link: 'https://www.theguardian.com/palau-world', publishedAt: Date.now() - 10_000 })]);
    put('Island Times (Palau)', [article('Island Times (Palau)', { publishedAt: Date.now() - 20_000 })]);
    const { payload } = await request();
    assert.equal(payload.countries.PW.items.length, 5);
    assert.deepEqual(payload.countries.PW.items.slice(0, 2).map(row => row.source), ['Guardian Pacific', 'Island Times (Palau)']);
    assert.equal(briefGroundingGap(selectCountryHeadlines(payload.countries.PW.items, 'PW')), null);
  });

  it('retains trusted newsroom identity across aggregator feeds and ignores forged origins', async () => {
    for (const [name, host] of [['Africa News', 'wire-one.example'], ['Sahel Crisis', 'wire-two.example']]) {
      const source = feed(name!);
      const xml = `<rss><channel><item><title>Mali agrees peace talks</title><source>Reuters</source><link>https://${host}/mali-talks</link><pubDate>${new Date(Date.now() - 3600_000).toUTCString()}</pubDate></item></channel></rss>`;
      cache.set(rssFeedCacheKey('full', source.url), digest.parseRssXml(xml, source, 'full'));
    }
    const { payload } = await request(['ML']);
    assert.deepEqual(payload.countries.ML.items.map(row => row.source), ['Reuters', 'Reuters']);
    assert.equal(briefGroundingGap(selectCountryHeadlines(payload.countries.ML.items, 'ML')), 'thin-grounding');
    put('Guardian Pacific', [article('Guardian Pacific', { originPublisher: 'Reuters', originPublisherTrusted: false })]);
    assert.equal((await request()).payload.countries.PW.items[0].source, 'Guardian Pacific');
  });

  it('rejects aggregator redirects before they can fill the country headline slots', async () => {
    put('Island Times (Palau)', [
      ...Array.from({ length: 5 }, (_, i) => article('Island Times (Palau)', { link: `https://news.google.com./rss/articles/opaque-${i}`, publishedAt: Date.now() - i * 1000 })),
      article('Island Times (Palau)'),
    ]);
    const { payload } = await request();
    assert.deepEqual(payload.countries.PW.items.map(row => row.link), ['https://islandtimes.org/palau-funding']);
  });

  it('reports missing or malformed caches as partial and a cache outage as unavailable', async () => {
    cache.delete(rssFeedCacheKey('full', feed('Guardian Pacific').url));
    cache.set(rssFeedCacheKey('full', feed('Guardian Africa').url), { items: 'invalid' });
    const partial = await request();
    assert.equal(partial.payload.state, 'partial');
    assert.equal(partial.payload.feedCached, partial.payload.feedTotal - 2);
    assert.equal(drainResponseHeaders(partial.req)?.['X-No-Cache'], '1');
    globalThis.fetch = async () => { throw new Error('fixture cache outage'); };
    const unavailable = await request();
    assert.equal(unavailable.payload.state, 'unavailable');
    assert.deepEqual(unavailable.payload.countries, {});
  });

  it('fails closed when the revocation set cannot be read', async () => {
    put('Island Times (Palau)', [article('Island Times (Palau)')]);
    failRevocations = true;
    const { payload, req } = await request();
    assert.equal(payload.state, 'unavailable');
    assert.deepEqual(payload.countries, {});
    assert.equal(drainResponseHeaders(req)?.['X-No-Cache'], '1');
  });

  it('rejects empty and oversized country requests before reading caches', async () => {
    for (const codes of [[], Array.from({ length: 251 }, () => 'PW')]) {
      assert.equal((await request(codes)).res.status, 400);
    }
    assert.deepEqual(commands, []);
  });
});
