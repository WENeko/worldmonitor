import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchGdacs } from '../scripts/seed-natural-events.mjs';

// GDACS changed `/gdacsapi/api/events/geteventlist/MAP` on or before 2026-09-16:
// a request without `eventtype` now answers `400 {"message":"Eventtype is
// required."}`, and `eventtype=ALL` or a `;`-joined list answers
// `400 {"message":"Please specify only 1 eventtype."}` (both probed live). The
// seeder had issued one bare MAP request since #5276, so every run logged
// `[GDACS] GDACS 400` and, whenever EONET also blipped, crashed gracefully
// (seed-natural-events, 4 of 4 runs in the 36 h window on 2026-09-16).

const GDACS_TYPES = ['EQ', 'FL', 'TC', 'VO', 'WF', 'DR'];

function feature(eventtype, eventid, alertlevel, extra = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [10 + eventid, 20 + eventid] },
    properties: {
      eventtype,
      eventid,
      alertlevel,
      name: `${eventtype} ${eventid}`,
      description: `${eventtype} event`,
      fromdate: '2026-09-15T00:00:00',
      url: { report: `https://www.gdacs.org/report.aspx?eventid=${eventid}&eventtype=${eventtype}` },
      ...extra,
    },
  };
}

/** Replicates the live endpoint contract observed on 2026-09-16. */
function gdacsStub(byType, { fail = {} } = {}) {
  const requests = [];
  const fetchFn = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.ok(url.hostname === 'www.gdacs.org', `unexpected host ${url.hostname}`);
    const eventtype = url.searchParams.get('eventtype');
    if (!eventtype) return Response.json({ message: 'Eventtype is required.' }, { status: 400 });
    if (eventtype.includes(';') || eventtype === 'ALL') {
      return Response.json({ message: 'Please specify only 1 eventtype.' }, { status: 400 });
    }
    if (fail[eventtype]) return new Response('upstream unavailable', { status: fail[eventtype] });
    return Response.json({ type: 'FeatureCollection', features: byType[eventtype] ?? [] });
  };
  return { fetchFn, requests };
}

test('requests one MAP list per GDACS event type and merges the non-green events', async () => {
  const { fetchFn, requests } = gdacsStub({
    EQ: [feature('EQ', 1, 'Orange')],
    FL: [feature('FL', 2, 'Orange'), feature('FL', 3, 'Green')],
    TC: [feature('TC', 4, 'Red', { severitydata: { severitytext: 'Cat 3' } })],
  });

  const events = await fetchGdacs(fetchFn);

  assert.deepEqual(
    requests.map((u) => u.searchParams.get('eventtype')).sort(),
    [...GDACS_TYPES].sort(),
    'one request per known GDACS event type, each carrying eventtype=',
  );
  assert.ok(requests.every((u) => u.pathname.endsWith('/geteventlist/MAP')), 'still the MAP list endpoint');
  assert.deepEqual(events.map((e) => e.id).sort(), ['gdacs-EQ-1', 'gdacs-FL-2', 'gdacs-TC-4']);
  assert.equal(events.find((e) => e.id === 'gdacs-FL-2').category, 'floods');
  assert.equal(events.find((e) => e.id === 'gdacs-TC-4').description, 'TC event - Cat 3');
});

test('a single failing type rejects the whole GDACS fetch so coverage is never overclaimed', async () => {
  // fetchNaturalEvents treats a rejected GDACS result as "cannot prove complete
  // empty coverage" (the exit-75 guard). A type that 503s is exactly that
  // partial coverage, so it must surface as a rejection, not as a shorter list.
  const { fetchFn } = gdacsStub({ EQ: [feature('EQ', 1, 'Orange')] }, { fail: { VO: 503 } });

  await assert.rejects(fetchGdacs(fetchFn), /GDACS 503 \(VO\)/);
});

test('dedupes an event that GDACS lists under two types by eventtype+eventid, not eventid alone', async () => {
  // eventid namespaces are per type, so the same number under EQ and FL is
  // two different events; the pre-existing `${eventtype}-${eventid}` key keeps
  // both. A duplicate within one type is still collapsed.
  const { fetchFn } = gdacsStub({
    EQ: [feature('EQ', 7, 'Orange'), feature('EQ', 7, 'Orange')],
    FL: [feature('FL', 7, 'Orange')],
  });

  const events = await fetchGdacs(fetchFn);

  assert.deepEqual(events.map((e) => e.id).sort(), ['gdacs-EQ-7', 'gdacs-FL-7']);
});
