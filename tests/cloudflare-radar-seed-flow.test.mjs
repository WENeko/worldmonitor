import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { __testing__ as health } from '../api/health.js';

const DDoS_KEY = 'cf:radar:ddos:v1';
const TRAFFIC_KEY = 'cf:radar:traffic-anomalies:v1';
const DDoS_META_KEY = 'seed-meta:cf:radar:ddos';
const TRAFFIC_META_KEY = 'seed-meta:cf:radar:traffic-anomalies';
const NOW = Date.parse('2026-09-07T12:00:00Z');

function runFixture(initial, mode = 'ok', now = NOW) {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `(${seedProcess.toString()})(${JSON.stringify(initial)}, ${now}, ${JSON.stringify(mode)})`],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        CLOUDFLARE_API_TOKEN: 'fixture-token',
        NODE_TEST_CONTEXT: 'child',
        TEST_SEED_URL: new URL('../scripts/seed-internet-outages.mjs', import.meta.url).href,
        UPSTASH_REDIS_REST_URL: 'https://redis.cloudflare-radar.test',
        UPSTASH_REDIS_REST_TOKEN: 'fixture-token',
        WM_SEED_ENV_FILE: '/dev/null',
      },
    },
  );
  const output = result.stdout + result.stderr;
  const fixture = output.match(/FIXTURE_RESULT=(.+)/);
  assert.ok(fixture, output);
  return {
    ...JSON.parse(fixture[1]),
    output,
    status: result.status,
  };
}

async function seedProcess(initial, now, mode) {
  Date.now = () => now;
  const store = new Map(initial);
  const calls = [];
  const ttlExtensions = [];

  const redisCommand = (command) => {
    const [name, key, value] = command;
    if (name === 'SET') {
      store.set(key, value);
      return 'OK';
    }
    if (name === 'DEL') return Number(store.delete(key));
    if (name === 'EXPIRE' || name === 'EVAL') return 1;
    throw new Error(`unexpected Redis command ${name}`);
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (url.origin === 'https://redis.cloudflare-radar.test') {
      if (url.pathname.startsWith('/get/')) {
        return Response.json({ result: store.get(decodeURIComponent(url.pathname.slice(5))) ?? null });
      }
      const command = JSON.parse(init.body);
      if (url.pathname === '/multi-exec') {
        if (mode === 'traffic-write-fail' && command.some((entry) => entry[1] === 'cf:radar:traffic-anomalies:v1')) {
          return Response.json([{ error: 'READONLY injected failure' }, { result: 'OK' }]);
        }
        for (const entry of command) redisCommand(entry);
        return Response.json(command.map(() => ({ result: 'OK' })));
      }
      if (url.pathname === '/pipeline') {
        for (const entry of command) {
          if (entry[0] === 'EXPIRE') ttlExtensions.push([entry[1], entry[2]]);
        }
        return Response.json(command.map((entry) => ({ result: redisCommand(entry) })));
      }
      return Response.json({ result: redisCommand(command) });
    }

    if (url.hostname !== 'api.cloudflare.com') throw new Error(`unexpected request ${url}`);
    if (url.pathname.endsWith('/annotations/outages')) {
      if (mode === 'annotations-fail' || mode === 'total-failure') return new Response('', { status: 503 });
      return Response.json({ success: true, result: { annotations: [] } });
    }
    if (url.pathname.endsWith('/summary/protocol') || url.pathname.endsWith('/summary/vector')) {
      if (mode === 'ddos-fail' || mode === 'success-false' || mode === 'total-failure') {
        return Response.json({ success: false, errors: [{ code: 7000 }] });
      }
      if (mode === 'malformed-errors') {
        return Response.json({ success: true, errors: { code: 7000 }, result: { summary_0: {}, meta: { dateRange: [] } } });
      }
      if (['target-fail', 'target-invalid', 'target-malformed'].includes(mode)) {
        const summary = url.pathname.endsWith('/summary/protocol') ? { TCP: '70' } : { SYN: '30' };
        return Response.json({ success: true, result: { summary_0: summary, meta: { dateRange: [] } } });
      }
      return Response.json({ success: true, result: { summary_0: {}, meta: { dateRange: [] } } });
    }
    if (url.pathname.endsWith('/top/locations/target')) {
      if (mode === 'target-fail') return new Response('', { status: 503 });
      if (mode === 'target-invalid') return Response.json({ success: false, errors: [{ code: 7000 }] });
      if (mode === 'target-malformed') return Response.json({ success: true, result: { top_0: [null] } });
      return Response.json({ success: true, result: { top_0: [] } });
    }
    if (url.pathname.endsWith('/traffic_anomalies')) {
      if (mode === 'traffic-fail' || mode === 'success-false' || mode === 'total-failure') {
        return Response.json({ success: false, errors: [{ code: 7000 }] });
      }
      if (mode === 'malformed-errors') {
        return Response.json({ success: true, errors: { code: 7000 }, result: { trafficAnomalies: [] } });
      }
      return Response.json({ success: true, result: { trafficAnomalies: [] } });
    }
    throw new Error(`unexpected Radar request ${url}`);
  };

  process.on('exit', () => {
    console.log(`FIXTURE_RESULT=${JSON.stringify({ calls, store: [...store], ttlExtensions })}`);
  });
  await import(process.env.TEST_SEED_URL);
}

function initialLastGood() {
  const oldMeta = JSON.stringify({ fetchedAt: NOW - 30 * 60_000, recordCount: 1 });
  return [
    [DDoS_KEY, JSON.stringify({ protocol: [{ label: 'old', percentage: 100 }], vector: [], topTargetLocations: [] })],
    [TRAFFIC_KEY, JSON.stringify({ anomalies: [{ uuid: 'old-event' }], totalCount: 1 })],
    [DDoS_META_KEY, oldMeta],
    [TRAFFIC_META_KEY, oldMeta],
  ];
}

function radarCallCounts(calls) {
  return calls.filter((path) => path.startsWith('/client/v4/radar/')).sort();
}

function assertCompanionTtlRetention(result, label) {
  const companions = result.ttlExtensions
    .filter(([key]) => key === DDoS_KEY || key === TRAFFIC_KEY)
    .sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(
    companions,
    [[DDoS_KEY, 10_800], [TRAFFIC_KEY, 3_600]],
    `${label}: failed runs must preserve each companion at its declared TTL`,
  );
}

async function readCompanionsThroughRpc(store) {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.cloudflare-radar.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://redis.cloudflare-radar.test');
    return Response.json({ result: store.get(decodeURIComponent(url.pathname.slice(5))) ?? null });
  };
  try {
    const [{ listInternetDdosAttacks }, { listInternetTrafficAnomalies }] = await Promise.all([
      import('../server/worldmonitor/infrastructure/v1/list-ddos-attacks.ts'),
      import('../server/worldmonitor/infrastructure/v1/list-traffic-anomalies.ts'),
    ]);
    return {
      ddos: await listInternetDdosAttacks({}, {}),
      traffic: await listInternetTrafficAnomalies({}, {}),
    };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  }
}

function classifyCompanion(name, key, metaKey, store) {
  return health.classifyKey(name, key, { allowOnDemand: false }, {
    keyStrens: new Map([[key, Buffer.byteLength(store.get(key) ?? '')]]),
    keyErrors: new Map(),
    keyMetaErrors: new Map(),
    keyMetaValues: new Map([[metaKey, store.get(metaKey)]]),
    now: NOW + 1_000,
  });
}

test('a confirmed empty Radar response replaces old companion payloads', () => {
  const result = runFixture(initialLastGood());

  assert.equal(result.status, 0, result.output);
  const store = new Map(result.store);
  assert.deepEqual(
    JSON.parse(store.get(DDoS_KEY)),
    { protocol: [], vector: [], dateRangeStart: '', dateRangeEnd: '', topTargetLocations: [] },
    'a valid empty DDoS response must clear the old protocol summary',
  );
  assert.deepEqual(
    JSON.parse(store.get(TRAFFIC_KEY)),
    { anomalies: [], totalCount: 0 },
    'a valid empty traffic response must clear the old anomaly event',
  );
  assert.equal(classifyCompanion('ddosAttacks', DDoS_KEY, DDoS_META_KEY, store).status, 'OK');
  assert.equal(classifyCompanion('trafficAnomalies', TRAFFIC_KEY, TRAFFIC_META_KEY, store).status, 'OK');
});

test('real companion RPC readers no longer serve old records after a confirmed empty response', async () => {
  const store = new Map(runFixture(initialLastGood()).store);
  const result = await readCompanionsThroughRpc(store);
  assert.deepEqual(result.ddos.protocol, []);
  assert.deepEqual(result.ddos.vector, []);
  assert.deepEqual(result.traffic.anomalies, []);
  assert.equal(result.traffic.totalCount, 0);
});

test('HTTP-200 invalid envelopes retain last-good companion payloads and success clocks', () => {
  for (const mode of ['success-false', 'malformed-errors']) {
    const initial = initialLastGood();
    const result = runFixture(initial, mode);
    const store = new Map(result.store);
    const before = new Map(initial);
    assert.notEqual(result.status, 0, `${mode}: ${result.output}`);
    for (const key of [DDoS_KEY, TRAFFIC_KEY, DDoS_META_KEY, TRAFFIC_META_KEY]) {
      assert.equal(store.get(key), before.get(key), `${mode}: ${key} must retain its last-good value`);
    }
    assert.equal(radarCallCounts(result.calls).length, 5, `${mode}: sources must not replay after settlement`);
    assertCompanionTtlRetention(result, mode);
  }
});

test('empty data stays authoritative through a source error and recovery', () => {
  const empty = new Map(runFixture(initialLastGood()).store);
  const failed = new Map(runFixture([...empty], 'traffic-fail', NOW + 60_000).store);
  const recovered = new Map(runFixture([...failed], 'ok', NOW + 120_000).store);

  assert.equal(failed.get(TRAFFIC_KEY), empty.get(TRAFFIC_KEY));
  assert.equal(failed.get(TRAFFIC_META_KEY), empty.get(TRAFFIC_META_KEY));
  assert.deepEqual(JSON.parse(recovered.get(TRAFFIC_KEY)), { anomalies: [], totalCount: 0 });
  assert.equal(JSON.parse(recovered.get(TRAFFIC_META_KEY)).fetchedAt, NOW + 120_000);
});

test('annotations and one companion can fail without discarding a healthy companion update', () => {
  for (const [mode, updatedKey, preservedKey] of [
    ['annotations-fail', TRAFFIC_KEY, null],
    ['ddos-fail', TRAFFIC_KEY, DDoS_KEY],
    ['traffic-fail', DDoS_KEY, TRAFFIC_KEY],
  ]) {
    const initial = initialLastGood();
    const result = runFixture(initial, mode);
    const store = new Map(result.store);
    const before = new Map(initial);
    assert.notEqual(result.status, 0, `${mode}: ${result.output}`);
    assert.equal(radarCallCounts(result.calls).length, 5, `${mode}: sources must not replay after settlement`);
    assert.notEqual(store.get(updatedKey), before.get(updatedKey), `${mode}: healthy companion must publish`);
    if (preservedKey) assert.equal(store.get(preservedKey), before.get(preservedKey), `${mode}: failed companion must retain last-good data`);
    assertCompanionTtlRetention(result, mode);
  }
});

test('a failed or malformed optional DDoS target slice does not discard required summaries', () => {
  for (const mode of ['target-fail', 'target-invalid', 'target-malformed']) {
    const result = runFixture(initialLastGood(), mode);
    const store = new Map(result.store);
    assert.equal(result.status, 0, `${mode}: ${result.output}`);
    const ddos = JSON.parse(store.get(DDoS_KEY));
    assert.deepEqual(ddos.protocol, [{ label: 'TCP', percentage: 70 }], mode);
    assert.deepEqual(ddos.vector, [{ label: 'SYN', percentage: 30 }], mode);
    assert.deepEqual(ddos.topTargetLocations, [], mode);
  }
});

test('an atomic companion write failure leaves its payload and success clock unchanged', () => {
  const initial = initialLastGood();
  const result = runFixture(initial, 'traffic-write-fail');
  const store = new Map(result.store);
  const before = new Map(initial);
  assert.notEqual(result.status, 0, result.output);
  assert.equal(store.get(TRAFFIC_KEY), before.get(TRAFFIC_KEY));
  assert.equal(store.get(TRAFFIC_META_KEY), before.get(TRAFFIC_META_KEY));
  assert.notEqual(store.get(DDoS_KEY), before.get(DDoS_KEY), 'the healthy DDoS companion must still publish');
  assert.equal(radarCallCounts(result.calls).length, 5, 'a cache write failure must not replay provider requests');
  assertCompanionTtlRetention(result, 'traffic-write-fail');
});

test('a total Radar failure keeps all companion last-good values', () => {
  const initial = initialLastGood();
  const result = runFixture(initial, 'total-failure');
  const store = new Map(result.store);
  const before = new Map(initial);
  assert.notEqual(result.status, 0, result.output);
  for (const key of [DDoS_KEY, TRAFFIC_KEY, DDoS_META_KEY, TRAFFIC_META_KEY]) {
    assert.equal(store.get(key), before.get(key), `${key} must survive total source failure`);
  }
  assert.equal(radarCallCounts(result.calls).length, 5, 'total failure must make one bounded provider pass');
  assertCompanionTtlRetention(result, 'total-failure');
});
