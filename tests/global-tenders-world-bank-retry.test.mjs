import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGlobalTenders, fetchTed, fetchWorldBank, sourceHealthMeta } from '../scripts/seed-global-tenders.mjs';

const NOW = Date.parse('2026-09-10T10:00:00Z');
const PAYLOAD = { procnotices: [{
  id: 'OP1', notice_type: 'Invitation for Bids', bid_description: 'Network services',
  project_ctry_code: 'IN', submission_deadline_date: '2026-10-01T00:00:00Z',
}] };

function provider(t, respond) {
  const calls = [];
  const waits = [];
  const timeouts = [];
  let elapsed = 0;
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    waits.push(ms);
    elapsed += ms;
    queueMicrotask(callback);
    return 0;
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    return respond({ elapsed, attempt: calls.length });
  });
  return { calls, waits, timeouts };
}

test('World Bank can recover after the former three-second retry window', async (t) => {
  const { calls, waits, timeouts } = provider(t, ({ elapsed }) => elapsed < 10_000
    ? new Response('upstream failure', { status: 500 })
    : Response.json(PAYLOAD));
  const result = await fetchWorldBank({ now: NOW });
  assert.deepEqual(waits, [5000, 10_000]);
  assert.equal(calls.length, 3);
  assert.deepEqual(timeouts, [20_000, 20_000, 20_000]);
  assert.equal(calls[0].options.retryDelayMs, undefined);
  assert.equal(new Set(calls.map((call) => call.url)).size, 1);
  assert.equal(new URL(calls[0].url).pathname, '/api/v2/procnotices');
  assert.equal(result.status.state, 'ok');
  assert.equal(result.records[0].id, 'world-bank:OP1');
});

test('other tender sources keep their existing retry interval', async (t) => {
  const { waits } = provider(t, ({ attempt }) => attempt < 3
    ? new Response('upstream failure', { status: 500 })
    : Response.json({ notices: [] }));
  const result = await fetchTed({ now: NOW });
  assert.equal(result.status.state, 'ok');
  assert.deepEqual(waits, [1000, 2000]);
});

test('exhausted World Bank retries retain data without advancing source success', async (t) => {
  const { calls, waits } = provider(t, () => new Response('upstream failure', { status: 500 }));
  const successfulAt = NOW - 60 * 60_000;
  const success = await fetchWorldBank({ now: successfulAt, fetchJsonFn: async () => PAYLOAD });
  let previousSnapshot = { tenders: success.records, sourceStatuses: [success.status], fetchedAt: successfulAt };
  for (const now of [NOW, NOW + 60 * 60_000]) {
    const snapshot = await fetchGlobalTenders({ now, previousSnapshot, adapters: [['world-bank', fetchWorldBank]] });
    assert.equal(snapshot.tenders.length, 1);
    assert.equal(snapshot.sourceStatuses[0].state, 'stale');
    assert.equal(snapshot.sourceStatuses[0].error, 'HTTP 500');
    assert.equal(snapshot.sourceStatuses[0].lastSuccessfulAt, new Date(successfulAt).toISOString());
    assert.equal(sourceHealthMeta(snapshot.sourceStatuses[0]).fetchedAt, successfulAt);
    assert.equal(sourceHealthMeta(snapshot.sourceStatuses[0]).sourceState, 'stale');
    previousSnapshot = snapshot;
  }
  assert.equal(calls.length, 6);
  assert.deepEqual(waits, [5000, 10_000, 5000, 10_000]);
});

test('World Bank permanent errors fail immediately', async (t) => {
  const { calls, waits } = provider(t, () => new Response('forbidden', { status: 403 }));
  await assert.rejects(fetchWorldBank({ now: NOW }), /HTTP 403/);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('World Bank distinguishes a valid empty response from malformed data', async (t) => {
  const { calls } = provider(t, ({ attempt }) => Response.json(attempt === 1 ? { procnotices: [] } : { error: 'unavailable' }));
  const result = await fetchWorldBank({ now: NOW });
  assert.deepEqual(result.records, []);
  assert.equal(result.status.state, 'ok');
  await assert.rejects(fetchWorldBank({ now: NOW }), /missing procnotices/);
  assert.equal(calls.length, 2);
});
