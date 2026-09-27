import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { __testing__ as health } from '../api/health.js';

const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const envelopeWriter = relay.slice(relay.indexOf('function buildEnvelope('), relay.indexOf('// Envelope-aware read.'));
const producer = relay.slice(relay.indexOf('const PIZZINT_SEED_INTERVAL_MS'), relay.indexOf('function startPizzintSeedLoop()'));
const emptyResponse = {
  success: true, data: [], events: [], overall_index: 0, defcon_level: 5,
  active_spikes: 0, has_active_spikes: false, timestamp: '2026-09-25T12:09:33.653Z',
  method: 'serverless', data_freshness: 'old',
};
const validResponse = { success: true, data: [{
  place_id: 'test-location', name: 'Test location', current_popularity: 75,
  percentage_of_usual: 150, data_freshness: 'fresh', recorded_at: '2026-09-25T11:39:00Z',
}] };

function harness() {
  const state = {
    source: validResponse, writes: [], warnings: [], cache: new Map(), now: 1_790_335_140_000, failPayload: false,
    urls: [], gdelt: { ok: true, status: 200, json: async () => ({}) },
    env: {}, besttime: new Map(), besttimeCalls: [],
  };
  class Clock extends Date { static now() { return state.now; } }
  const context = vm.createContext({
    Date: Clock, AbortSignal, CHROME_UA: 'test', console: { log() {}, warn: (...args) => state.warnings.push(args) },
    process: { env: state.env },
    fetch: async (url, init) => {
      state.urls.push(url);
      if (url.includes('besttime.app')) {
        state.besttimeCalls.push({ url, method: init?.method });
        const reply = state.besttime.get(new URL(url).searchParams.get('venue_id'));
        if (reply instanceof Error) throw reply;
        return reply ?? { ok: true, status: 200, json: async () => liveUnavailable };
      }
      if (url.includes('dashboard-data') && state.source instanceof Error) throw state.source;
      return url.includes('dashboard-data') ? { ok: true, json: async () => state.source } : state.gdelt;
    },
    upstashSet: async (key, data, ttl) => {
      if (key === payloadKey && state.failPayload) return false;
      state.writes.push(key);
      state.cache.set(key, { data: structuredClone(data), expiresAt: state.now + ttl * 1000 });
      return true;
    },
  });
  vm.runInContext(envelopeWriter + producer, context);
  return { state, seed: () => vm.runInContext('seedPizzint()', context) };
}

const liveUnavailable = { status: 'Error', message: 'No live data available.', analysis: { venue_live_busyness_available: false, venue_forecasted_busyness: 20 }, venue_info: { venue_open: 'Open' } };
const liveReading = (live, forecast, extra = {}) => ({
  ok: true, status: 200, json: async () => ({
    status: 'OK',
    analysis: { venue_live_busyness: live, venue_live_busyness_available: true, venue_forecast_busyness_available: true, venue_forecasted_busyness: forecast, venue_live_forecasted_delta: live - forecast },
    venue_info: { venue_open: 'Open', venue_address: '1419 S Fern St Arlington VA 22202', ...extra },
  }),
});

const payloadKey = 'intelligence:pizzint:seed:v1';
const metaKey = 'seed-meta:intelligence:pizzint';

for (const [reason, response] of [
  ['unsuccessful_response', { success: false, data: [] }],
  ['non_array_data', { success: true, data: { token: 'synthetic-secret' } }],
  ['empty_array', { success: true, data: [] }],
]) {
  test(`classifies ${reason} without logging response content or changing publication`, async () => {
    const { state, seed } = harness();
    await seed();
    const previous = structuredClone(state.cache);
    state.now += 600_000;
    state.source = {
      ...response,
      message: 'https://example.invalid/?token=synthetic-secret',
      token: 'synthetic-secret',
      reason: 'synthetic-secret\nforged log entry',
    };
    await seed();
    assert.deepEqual(state.warnings, [[
      `[PizzINT] No data in API response (${reason}); preserving last good observation`,
    ]], 'only the fixed category is logged; no payload fields or extra arguments');
    assert.deepEqual(state.cache, previous);
    assert.equal(state.writes.length, 2);
  });
}

test('empty upstream response preserves the last observation and its original expiry', async () => {
  const { state, seed } = harness();
  await seed();
  assert.equal(state.cache.get(payloadKey).data.data.pizzint.defconLevel, 2);
  const previous = structuredClone(state.cache);
  state.now += 600_000;
  state.source = emptyResponse;
  await seed();
  assert.deepEqual(state.cache, previous);
  assert.equal(state.writes.length, 2);
});

test('first-run emptiness publishes no normal activity and a later valid response recovers', async () => {
  const { state, seed } = harness();
  state.source = emptyResponse;
  await seed();
  assert.equal(state.cache.size, 0);
  state.source = validResponse;
  await seed();
  assert.equal(state.cache.get(payloadKey).data.data.pizzint.locationsMonitored, 1);
  assert.equal(state.cache.get(metaKey).data.recordCount, 1);
});

test('failed payload publication does not advance success metadata', async () => {
  const { state, seed } = harness();
  await seed();
  const previous = structuredClone(state.cache);
  state.now += 600_000;
  state.failPayload = true;
  await seed();
  assert.deepEqual(state.cache, previous);
  assert.equal(state.writes.length, 2);
});

test('a sustained empty source still expires the payload and fails the real health classifier', async () => {
  const { state, seed } = harness();
  await seed();
  const classify = () => health.classifyKey('pizzint', payloadKey, { allowOnDemand: false }, {
    keyStrens: new Map([[payloadKey, state.now < state.cache.get(payloadKey).expiresAt ? 100 : 0]]),
    keyErrors: new Map(), keyMetaErrors: new Map(),
    keyMetaValues: new Map([[metaKey, JSON.stringify(state.cache.get(metaKey).data)]]),
    now: state.now,
  });
  assert.equal(classify().status, 'OK');
  state.source = emptyResponse;
  state.now += 31 * 60_000;
  await seed();
  const expired = classify();
  assert.notEqual(expired.status, 'OK');
  assert.equal(expired.seedAgeMin, 31);
  assert.ok(['warn', 'crit'].includes(health.STATUS_COUNTS[expired.status]));
});

// The GDELT batch endpoint rejects a request without a window (400 "Missing
// required query parameters: pairs, method, dateStart, dateEnd") and validates
// "Invalid date format. Expected YYYYMMDD." — observed live 2026-09-26.
test('requests GDELT tensions with the YYYYMMDD window the endpoint requires', async () => {
  const { state, seed } = harness();
  state.gdelt = { ok: true, status: 200, json: async () => ({
    usa_iran: [{ t: '20260924', v: 2 }, { t: '20260925', v: 3 }],
  }) };
  await seed();
  const gdeltUrl = new URL(state.urls.find((url) => url.includes('gdelt/batch')));
  assert.equal(gdeltUrl.searchParams.get('method'), 'gpr');
  assert.equal(gdeltUrl.searchParams.get('dateEnd'), '20260925');
  assert.equal(gdeltUrl.searchParams.get('dateStart'), '20260826');
  const payload = JSON.stringify(state.cache.get(payloadKey).data);
  assert.match(payload, /"id":"usa_iran"/);
  assert.match(payload, /"changePercent":50/);
});

test('reports a rejected GDELT request by status without logging its body', async () => {
  const { state, seed } = harness();
  state.gdelt = { ok: false, status: 400, json: async () => ({ error: 'synthetic-secret' }) };
  await seed();
  assert.deepEqual(state.warnings, [['[PizzINT] GDELT tensions request rejected (HTTP 400)']]);
  assert.ok(state.writes.includes(payloadKey), 'a GDELT failure never blocks the PizzINT publication');
});

// PizzINT's own backend went empty on 2026-09-25 (dashboard-data `data: []`,
// neh-index and gdelt/batch 500 "Failed to fetch data from Supabase"). BestTime
// live busyness for the same Pentagon-area venues replaces the feed while it is
// down; without a live reading nothing is published, as before.
const BESTTIME_KEY = 'pri_test_secret_value';
for (const [label, baseline] of [
  ['unavailable forecast', { venue_forecast_busyness_available: false, venue_forecasted_busyness: 0, venue_live_forecasted_delta: 60 }],
  ['missing forecast', { venue_forecast_busyness_available: true }],
  ['non-finite forecast', { venue_forecast_busyness_available: true, venue_forecasted_busyness: NaN }],
  ['zero forecast', { venue_forecast_busyness_available: true, venue_forecasted_busyness: 0 }],
]) {
  test(`keeps live readings without inventing spikes from ${label}`, async () => {
    const { state, seed } = harness();
    state.source = emptyResponse;
    state.env.BESTTIME_API_KEY_PRIVATE = BESTTIME_KEY;
    await seed();
    for (const { url } of state.besttimeCalls) {
      state.besttime.set(new URL(url).searchParams.get('venue_id'), {
        ok: true, json: async () => ({
          analysis: { venue_live_busyness_available: true, venue_live_busyness: 60, ...baseline },
          venue_info: { venue_open: 'Open' },
        }),
      });
    }
    await seed();
    const { pizzint } = state.cache.get(payloadKey).data.data;
    assert.equal(pizzint.aggregateActivity, 60);
    assert.equal(pizzint.activeSpikes, 0);
    assert.equal(pizzint.defconLevel, 3);
    for (const location of pizzint.locations) {
      assert.equal(location.percentageOfUsual, 0);
      assert.equal(location.spikeMagnitude, 0);
    }
  });
}

test('falls back to BestTime live busyness when PizzINT is empty', async () => {
  const { state, seed } = harness();
  state.source = emptyResponse;
  state.env.BESTTIME_API_KEY_PRIVATE = BESTTIME_KEY;
  await seed();
  const ids = state.besttimeCalls.map(({ url }) => new URL(url).searchParams.get('venue_id'));
  assert.ok(ids.length >= 4, 'every registered venue is polled');
  assert.ok(state.besttimeCalls.every(({ method, url }) => method === 'POST' && new URL(url).pathname === '/api/v1/forecasts/live'));
  assert.equal(state.cache.has(payloadKey), false, 'no live reading, nothing published');
  assert.deepEqual(state.warnings.at(-1), [`[PizzINT] BestTime fallback: no live readings (0/${ids.length} venues); preserving last good observation`]);

  state.besttime.set(ids[0], liveReading(90, 40));
  state.besttime.set(ids[1], liveReading(30, 35));
  state.besttime.set(ids[2], new Error(`network down ${BESTTIME_KEY}`));
  state.now += 600_000;
  await seed();
  const { data } = state.cache.get(payloadKey);
  const payload = JSON.stringify(data);
  const { pizzint } = data.data ?? data;
  assert.equal(pizzint.locationsMonitored, 2, 'only venues with a live reading are published');
  assert.equal(pizzint.activeSpikes, 1);
  assert.equal(pizzint.aggregateActivity, 60);
  assert.equal(pizzint.defconLevel, 2, '60 + 10 per spike = 70');
  const [spike, calm] = pizzint.locations;
  assert.deepEqual(
    { id: spike.placeId, pop: spike.currentPopularity, pct: spike.percentageOfUsual, spike: spike.isSpike, mag: spike.spikeMagnitude, src: spike.dataSource, fresh: spike.dataFreshness },
    { id: ids[0], pop: 90, pct: 225, spike: true, mag: 50, src: 'besttime', fresh: 'DATA_FRESHNESS_FRESH' },
  );
  assert.equal(calm.isSpike, false);
  assert.equal(calm.percentageOfUsual, 86);
  assert.equal(state.cache.get(metaKey).data.recordCount, 2);
  assert.doesNotMatch(payload + JSON.stringify(state.warnings), /pri_test_secret_value/);
});

test('never calls BestTime while PizzINT answers or without a key', async () => {
  const withKey = harness();
  withKey.state.env.BESTTIME_API_KEY_PRIVATE = BESTTIME_KEY;
  await withKey.seed();
  assert.equal(withKey.state.besttimeCalls.length, 0);
  assert.match(JSON.stringify(withKey.state.cache.get(payloadKey).data), /test-location/);

  const noKey = harness();
  noKey.state.source = emptyResponse;
  await noKey.seed();
  assert.equal(noKey.state.besttimeCalls.length, 0);
  assert.equal(noKey.state.cache.has(payloadKey), false);
});

test('marks a live venue that BestTime reports closed and keeps it out of the open average', async () => {
  const { state, seed } = harness();
  state.source = { success: false };
  state.env.BESTTIME_API_KEY_PRIVATE = BESTTIME_KEY;
  await seed();
  const ids = state.besttimeCalls.map(({ url }) => new URL(url).searchParams.get('venue_id'));
  state.besttimeCalls.length = 0;
  state.besttime.set(ids[0], liveReading(40, 40));
  state.besttime.set(ids[1], liveReading(80, 20, { venue_open: 'Closed' }));
  state.now += 600_000;
  await seed();
  const { pizzint } = state.cache.get(payloadKey).data.data ?? state.cache.get(payloadKey).data;
  assert.equal(pizzint.locationsOpen, 1);
  assert.equal(pizzint.aggregateActivity, 40);
  assert.equal(pizzint.locations[1].isClosedNow, true);
});

test('falls back to BestTime when the PizzINT request itself fails', async () => {
  const { state, seed } = harness();
  state.source = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  state.env.BESTTIME_API_KEY_PRIVATE = BESTTIME_KEY;
  await seed();
  const ids = state.besttimeCalls.map(({ url }) => new URL(url).searchParams.get('venue_id'));
  assert.ok(ids.length >= 4, 'a thrown PizzINT fetch still reaches the fallback');
  state.besttime.set(ids[0], liveReading(50, 40));
  state.now += 600_000;
  await seed();
  const { pizzint } = state.cache.get(payloadKey).data.data ?? state.cache.get(payloadKey).data;
  assert.equal(pizzint.locationsMonitored, 1);
});

test('ignores a BestTime error response even when its body looks like a live reading', async () => {
  const { state, seed } = harness();
  state.source = emptyResponse;
  state.env.BESTTIME_API_KEY_PRIVATE = BESTTIME_KEY;
  await seed();
  const ids = state.besttimeCalls.map(({ url }) => new URL(url).searchParams.get('venue_id'));
  state.besttime.set(ids[0], { ...liveReading(90, 40), ok: false, status: 429 });
  state.besttime.set(ids[1], liveReading(30, 35));
  state.now += 600_000;
  await seed();
  const { pizzint } = state.cache.get(payloadKey).data.data ?? state.cache.get(payloadKey).data;
  assert.deepEqual(pizzint.locations.map((l) => l.placeId), [ids[1]]);
});
