import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';
import { admitCountryPanel, authorizePanelRead, PANEL_READ_LIMIT } from '../api/mcp/panel-requests.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const context = { kind: 'pro', userId: 'user_pro_xyz', mcpTokenId: 'k57mcptokenid' };
const budget = { allowance: 'mcp', limit: 50 };
const energy = { section: 'energy', arguments: { country_code: 'US' } };
describe('paid country workflow through the MCP handler', () => {
  let handler;
  let fetched;
  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    fetched = [];
    globalThis.fetch = async url => { fetched.push(String(url)); return Response.json({ countryCode: 'US', available: true }); };
    handler = (await import('../api/mcp.ts')).mcpHandler;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });
  const invoke = async (deps, name, args) => {
    const response = await handler(proReq('POST', callBody(name, args)), deps);
    return { response, body: await response.json() };
  };
  it('charges concurrent opens once, includes internal loads, replays ready data and charges explicit refresh', async () => {
    const { deps, pipe } = makeProDeps();
    const opened = await Promise.all(Array.from({ length: 10 }, () => invoke(deps, 'open_country_brief', { country_code: 'US' })));
    assert.equal(pipe.count, 1);
    const receipt = opened[0].body.result.structuredContent.panelRequest;
    assert.equal(receipt.usage.remaining, 49);
    assert.equal(opened.filter(item => !item.body.result.structuredContent.panelRequest.reused).length, 1);
    const read = await invoke(deps, 'get_country_brief_section', { ...energy, panel_request: receipt.token });
    assert.equal(read.body.result.structuredContent.state, 'ready');
    await invoke(deps, 'get_country_brief_section', { panel_request: receipt.token, arguments: { country_code: 'US' }, section: 'energy' });
    assert.equal(fetched.length, 1);
    assert.equal(pipe.count, 1);
    const request_id = crypto.randomUUID();
    const refreshed = await invoke(deps, 'open_country_brief', { country_code: 'US', refresh: true, request_id });
    await invoke(deps, 'open_country_brief', { country_code: 'US', refresh: true, request_id });
    assert.equal(pipe.count, 2);
    assert.equal(refreshed.body.result.structuredContent.panelRequest.usage.remaining, 48);
    await invoke(deps, 'get_country_brief_section', { ...energy, panel_request: refreshed.body.result.structuredContent.panelRequest.token });
    assert.equal(fetched.length, 2);
  });
  it('includes a full country reader graph and ten exposure/dependency sectors in one charge', async () => {
    const { deps, pipe } = makeProDeps();
    const opened = await invoke(deps, 'open_country_brief', { country_code: 'US' });
    const token = opened.body.result.structuredContent.panelRequest.token;
    const readers = [
      ...['facts', 'energy', 'maritime', 'risk', 'stock', 'defense'].map(section => [section, { country_code: 'US' }]),
      ...['food', 'demographics', 'resilience', 'factors'].map(section => [section, { countryCode: 'US' }]),
      ...['products', 'commodities'].map(section => [section, { iso2: 'US' }]),
      ['markets', { category: 'country:US', page_size: 5 }],
      ['debt', {}], ['flows', { reporter_code: '842' }], ['tariffs', { reporting_country: '840' }],
      ['housing', { keys: 'bisDsr,bisPropertyResidential,bisPropertyCommercial' }],
      ['imf', { keys: 'imfMacro,imfGrowth,imfLabor,imfExternal' }],
      ['bypass', { chokepointId: 'hormuz' }],
      ['production', { commodity: 'copper', iso2: '', stage: '' }],
      ...['27', '84', '85', '87', '30', '72', '39', '29', '10', '62'].flatMap(hs2 => [['exposure', { iso2: 'US', hs2 }], ['dependency', { iso2: 'US', hs2 }]]),
    ];
    for (const [section, args] of readers) {
      const read = await invoke(deps, 'get_country_brief_section', { section, arguments: args, panel_request: token });
      assert.equal(read.body.result?.structuredContent?.state, 'ready', `included reader ${section}`);
    }
    assert.equal(fetched.length, readers.length);
    assert.equal(pipe.count, 1);
    for (const name of ['get_country_brief', 'get_country_coverage']) {
      const read = await authorizePanelRead(context, pipe.pipeline, name, { country_code: 'US' }, token);
      await read.save({ countryCode: 'US', brief: 'Controlled assessment', headlines: [] });
      assert.equal((await authorizePanelRead(context, pipe.pipeline, name, { country_code: 'US' }, token)).cached.countryCode, 'US');
    }
    assert.equal(pipe.count, 1);
  });
  it('returns HTTP 429 with Retry-After at the read ceiling and does not fetch or charge again', async () => {
    const { deps, pipe } = makeProDeps();
    const opened = await invoke(deps, 'open_country_brief', { country_code: 'US' });
    const args = { ...energy, panel_request: opened.body.result.structuredContent.panelRequest.token };
    globalThis.fetch = async () => { fetched.push('outage'); return Response.json({ upstreamUnavailable: true }); };
    for (let i = 0; i < PANEL_READ_LIMIT; i++) await invoke(deps, 'get_country_brief_section', args);
    const denied = await invoke(deps, 'get_country_brief_section', args);
    assert.equal(denied.response.status, 429);
    assert.ok(Number(denied.response.headers.get('Retry-After')) > 0);
    assert.equal(fetched.length, PANEL_READ_LIMIT);
    assert.equal(pipe.count, 1);
  });
  it('permits an already paid request at the daily cap and denies a new refresh without dispatch', async () => {
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 49 } });
    const opened = await invoke(deps, 'open_country_brief', { country_code: 'US' });
    const token = opened.body.result.structuredContent.panelRequest.token;
    assert.equal((await invoke(deps, 'get_country_brief_section', { ...energy, panel_request: token })).response.status, 200);
    assert.equal((await invoke(deps, 'open_country_brief', { country_code: 'US' })).body.result.structuredContent.panelRequest.reused, true);
    const denied = await invoke(deps, 'open_country_brief', { country_code: 'US', refresh: true });
    assert.equal(denied.response.status, 429);
    assert.ok(denied.response.headers.get('Retry-After'));
    assert.equal(pipe.count, 50);
    assert.equal(fetched.length, 1);
  });
  it('retains current entitlement checks before returning a cached result', async () => {
    let revoked = false;
    const { deps } = makeProDeps({ getEntitlements: async () => ({ planKey: 'pro', features: { tier: 1, mcpAccess: !revoked }, validUntil: Date.now() + 86400000 }) });
    const opened = await invoke(deps, 'open_country_brief', { country_code: 'US' });
    const args = { ...energy, panel_request: opened.body.result.structuredContent.panelRequest.token };
    await invoke(deps, 'get_country_brief_section', args);
    revoked = true;
    const denied = await invoke(deps, 'get_country_brief_section', args);
    assert.equal(denied.response.status, 403);
    assert.equal(fetched.length, 1);
  });
  it('preserves weighted API billing and refuses panel tokens on API allowances', async () => {
    const { deps, pipe } = makeProDeps({ getEntitlements: async () => ({ planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: Date.now() + 86400000 }) });
    const opened = await invoke(deps, 'open_country_brief', { country_code: 'US' });
    assert.equal(opened.body.result.structuredContent.panelRequest, undefined);
    await invoke(deps, 'get_country_brief_section', energy);
    assert.equal(pipe.count, 4);
    const denied = await invoke(deps, 'get_country_brief_section', { ...energy, panel_request: 'invalid' });
    assert.equal(denied.body.error.code, -32602);
    assert.equal(pipe.count, 4);
  });
  it('does not cache a failed section or refund its admitted work', async () => {
    const { deps, pipe } = makeProDeps();
    const opened = await invoke(deps, 'open_country_brief', { country_code: 'US' });
    const args = { ...energy, panel_request: opened.body.result.structuredContent.panelRequest.token };
    globalThis.fetch = async () => { fetched.push('failure'); return new Response('denied', { status: 403 }); };
    assert.equal((await invoke(deps, 'get_country_brief_section', args)).body.result.structuredContent.state, 'locked');
    await invoke(deps, 'get_country_brief_section', args);
    assert.equal(fetched.length, 2);
    assert.equal(pipe.count, 1);
    globalThis.fetch = async () => { fetched.push('outage'); return Response.json({ upstreamUnavailable: true }); };
    await invoke(deps, 'get_country_brief_section', args);
    await invoke(deps, 'get_country_brief_section', args);
    assert.equal(fetched.length, 4);
    const coverage = await authorizePanelRead(context, pipe.pipeline, 'get_country_coverage', { country_code: 'US' }, args.panel_request);
    await coverage.save({ countryCode: 'US', degraded: true });
    assert.equal((await authorizePanelRead(context, pipe.pipeline, 'get_country_coverage', { country_code: 'US' }, args.panel_request)).cached, undefined);
  });
  it('rejects another user, country, tool, custom assessment, reporter or forged signature before fetching', async () => {
    const { deps, pipe } = makeProDeps();
    const grant = await admitCountryPanel(context, budget, pipe.pipeline, { country_code: 'US' });
    const read = (ctx, name, args, token = grant.token) => authorizePanelRead(ctx, pipe.pipeline, name, args, token);
    await assert.rejects(read({ ...context, userId: 'other' }, 'get_country_brief_section', energy));
    for (const [name, args] of [
      ['get_country_brief_section', { section: 'energy', arguments: { country_code: 'UA' } }],
      ['get_country_brief_section', { section: 'flows', arguments: { reporter_code: '156' } }],
      ['get_country_brief_section', { section: 'flows', arguments: { reporter_code: '840' } }],
      ['get_country_brief_section', { section: 'production', arguments: { commodity: 'copper', iso2: 'CN' } }],
      ['get_country_brief_section', { section: 'markets', arguments: { category: 'country:UA', page_size: 5 } }],
      ['get_country_brief_section', { section: 'china', arguments: {} }],
      ['get_country_brief', { country_code: 'US', framework: 'Custom' }],
      ['get_country_brief', { country_code: 'UA' }],
      ['get_country_coverage', { country_code: 'UA' }],
      ['get_market_data', {}],
    ]) await assert.rejects(read(context, name, args));
    await assert.rejects(read(context, 'get_country_brief_section', energy, grant.token.slice(0, -1) + (grant.token.endsWith('a') ? 'b' : 'a')));
    const invalid = await invoke(deps, 'get_country_brief_section', { ...energy, panel_request: 'forged' });
    assert.equal(invalid.body.error.code, -32602);
    assert.equal(pipe.count, 1);
    assert.equal(fetched.length, 0);
  });
  it('bounds failed retries, checks expiry, and fails closed when Redis cannot prove admission', async () => {
    const { pipe } = makeProDeps();
    const now = Date.UTC(2026, 9, 2, 12);
    const grant = await admitCountryPanel(context, budget, pipe.pipeline, { country_code: 'US' }, now);
    await assert.rejects(authorizePanelRead(context, pipe.pipeline, 'get_country_brief_section', energy, grant.token, Date.parse(grant.expiresAt)));
    for (let i = 0; i < PANEL_READ_LIMIT; i++) await authorizePanelRead(context, pipe.pipeline, 'get_country_brief_section', energy, grant.token, now);
    await assert.rejects(authorizePanelRead(context, pipe.pipeline, 'get_country_brief_section', energy, grant.token, now), error => error.code === 'reads');
    const outage = async () => { throw new Error('Redis outage'); };
    await assert.rejects(authorizePanelRead(context, outage, 'get_country_brief_section', energy, grant.token, now), error => error.code === 'backend');
    await assert.rejects(admitCountryPanel(context, budget, outage, { country_code: 'US' }, now), error => error.code === 'backend');
    assert.equal(fetched.length, 0);
  });
  it('reuses a still-valid preceding bucket but charges again after UTC reset', async () => {
    const { pipe } = makeProDeps();
    const now = Date.UTC(2026, 9, 2, 12, 4, 59);
    const first = await admitCountryPanel(context, budget, pipe.pipeline, { country_code: 'US' }, now);
    const repeat = await admitCountryPanel(context, budget, pipe.pipeline, { country_code: 'US' }, now + 2000);
    assert.equal(repeat.token, first.token);
    assert.equal(repeat.reused, true);
    assert.equal(pipe.count, 1);
    const midnight = Date.UTC(2026, 9, 3);
    const evening = await admitCountryPanel(context, budget, pipe.pipeline, { country_code: 'US' }, midnight - 1000);
    assert.equal(Date.parse(evening.expiresAt), midnight);
    const morning = await admitCountryPanel(context, budget, pipe.pipeline, { country_code: 'US' }, midnight + 1000);
    assert.equal(morning.reused, false);
    assert.equal(pipe.count, 3);
  });
  it('a refresh retry returns the original paid expiry and token without extending its lifetime', async () => {
    const { pipe } = makeProDeps();
    const now = Date.UTC(2026, 9, 2, 12);
    const args = { country_code: 'US', refresh: true, request_id: crypto.randomUUID() };
    const first = await admitCountryPanel(context, budget, pipe.pipeline, args, now);
    const retry = await admitCountryPanel(context, budget, pipe.pipeline, args, now + 60000);
    assert.equal(retry.token, first.token);
    assert.equal(retry.expiresAt, first.expiresAt);
    assert.equal(pipe.count, 1);
    await authorizePanelRead(context, pipe.pipeline, 'get_country_brief_section', energy, retry.token, now + 299999);
    await assert.rejects(authorizePanelRead(context, pipe.pipeline, 'get_country_brief_section', energy, retry.token, now + 300000), error => error.code === 'invalid');
  });
});
