import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildAgentMarkdownCacheRule, planAgentReadiness, runAgentReadiness } from '../scripts/cloudflare-agent-readiness.mjs';
import policy from '../shared/agent-request-policy.json' with { type: 'json' };

function fixture() {
  return {
    firewall: { id: 'firewall', rules: [
      { id: 'auth', description: 'Allow authenticated API', action: 'skip', expression: 'authenticated', enabled: true },
      ...['Block API Bots', 'Block Scriptlike UAs'].map((description, i) => ({
        id: `block-${i}`, description, action: 'block', enabled: true, expression: `api-policy-${i}`,
      })),
    ] },
    cache: { id: 'cache', rules: [
      { id: 'html', action: 'set_cache_settings', action_parameters: { cache: true }, expression: 'homepage' },
    ] },
  };
}

function fakeCloudflare(state, { drift = false } = {}) {
  const writes = [];
  let firewallReads = 0;
  return { writes, fetchImpl: async (url, options) => {
    const path = new URL(url).pathname;
    const response = (result) => Response.json({ success: true, result });
    if (path === '/client/v4/zones') return response([{ id: 'zone', name: 'worldmonitor.app' }]);
    if (options.method === 'GET') {
      if (path.includes('firewall_custom')) {
        if (drift && ++firewallReads === 2) state.firewall.rules[1].expression = 'changed-by-owner';
        return response(state.firewall);
      }
      if (path.includes('cache_settings')) return response(state.cache);
      throw new Error(`Unexpected read ${path}`);
    }
    const body = JSON.parse(options.body);
    writes.push({ method: options.method, path, body });
    const ruleset = path.includes('/rulesets/firewall/') ? state.firewall : state.cache;
    const ruleId = path.split('/').at(-1);
    let rule;
    if (options.method === 'PATCH') {
      rule = ruleset.rules.find((item) => item.id === ruleId);
      assert.ok(rule);
      const index = ruleset.rules.indexOf(rule);
      rule = { id: rule.id, ...body };
      ruleset.rules[index] = rule;
    } else {
      assert.equal(options.method, 'POST');
      rule = { id: 'agent-cache', ...body };
      ruleset.rules.push(rule);
    }
    if (body.position) {
      ruleset.rules = ruleset.rules.filter((item) => item.id !== rule.id);
      assert.deepEqual(body.position, { after: '' });
      ruleset.rules.push(rule);
      delete rule.position;
    }
    return response(ruleset);
  } };
}

describe('Cloudflare agent readiness', () => {
  it('rejects ambiguous CLI modes before loading credentials or making requests', () => {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('../scripts/cloudflare-agent-readiness.mjs', import.meta.url)), '--apply', '--plan',
    ], { encoding: 'utf8', env: {} });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
    assert.equal(result.stdout, '');
  });

  it('limits the cache bypass to homepage GET/HEAD and the declared AI user agents', () => {
    const rule = buildAgentMarkdownCacheRule();
    assert.match(rule.expression, /http\.host in \{"worldmonitor\.app" "www\.worldmonitor\.app"\}/);
    assert.match(rule.expression, /http\.request\.uri\.path eq "\/"/);
    assert.match(rule.expression, /http\.request\.method in \{"GET" "HEAD"\}/);
    for (const ua of policy.userAgents) assert.ok(rule.expression.includes(`contains "${ua.toLowerCase()}"`));
    assert.doesNotMatch(rule.expression, /googlebot|api\.worldmonitor\.app/);
    assert.deepEqual(rule.action_parameters, { cache: false });
  });

  it('plans without a write and changes only the block response parameters', async () => {
    const state = fixture();
    const original = structuredClone(state);
    const api = fakeCloudflare(state);
    const result = await runAgentReadiness('--plan', { env: { CLOUDFLARE_API_TOKEN: 'test' }, fetchImpl: api.fetchImpl });
    assert.equal(result.ready, false);
    assert.equal(result.changes.length, 3);
    assert.equal(api.writes.length, 0);
    assert.deepEqual(state, original);
    for (const change of result.changes.slice(0, 2)) {
      const originalRule = original.firewall.rules.find((rule) => rule.id === change.ruleId);
      const { id, ...definition } = originalRule;
      const { action_parameters, ...changedDefinition } = change.body;
      assert.deepEqual(changedDefinition, definition);
      const response = change.body.action_parameters.response;
      assert.equal(response.status_code, 403);
      assert.equal(response.content_type, 'application/json');
      assert.deepEqual(JSON.parse(response.content), policy.blockedResponse);
    }
  });

  it('applies individual rules, preserves security policy, verifies, and is idempotent', async () => {
    const state = fixture();
    const original = structuredClone(state.firewall.rules);
    const api = fakeCloudflare(state);
    const options = { env: { CLOUDFLARE_API_TOKEN: 'test' }, fetchImpl: api.fetchImpl };
    assert.equal((await runAgentReadiness('--apply', options)).ready, true);
    assert.deepEqual(api.writes.map((write) => write.method), ['PATCH', 'PATCH', 'POST']);
    assert.deepEqual(state.firewall.rules.map(({ action_parameters, ...rest }) => rest), original);
    assert.equal(state.cache.rules.at(-1).ref, buildAgentMarkdownCacheRule().ref);
    assert.equal((await runAgentReadiness('--apply', options)).ready, true);
    assert.equal(api.writes.length, 3);
  });

  it('moves its cache bypass after later cache rules', () => {
    const state = fixture();
    state.cache.rules.unshift({ id: 'agent-cache', ...buildAgentMarkdownCacheRule() });
    const change = planAgentReadiness(state.firewall, state.cache).at(-1);
    assert.equal(change.ruleId, 'agent-cache');
    assert.deepEqual(change.body.position, { after: '' });
  });

  it('stops on concurrent rule changes before writing', async () => {
    const api = fakeCloudflare(fixture(), { drift: true });
    await assert.rejects(runAgentReadiness('--apply', {
      env: { CLOUDFLARE_API_TOKEN: 'test' }, fetchImpl: api.fetchImpl,
    }), /changed after planning/);
    assert.equal(api.writes.length, 0);
  });

  it('refuses missing or disabled block rules and conflicting cache ownership', () => {
    const state = fixture();
    state.firewall.rules[1].enabled = false;
    assert.throws(() => planAgentReadiness(state.firewall, state.cache), /Expected one enabled block rule/);
    state.firewall.rules[1].enabled = true;
    state.cache.rules.push({ id: 'foreign', ...buildAgentMarkdownCacheRule(), ref: 'another-owner' });
    assert.throws(() => planAgentReadiness(state.firewall, state.cache), /unexpected ref/);
  });
});
