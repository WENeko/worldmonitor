import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import policy from './shared/agent-request-policy.json' with { type: 'json' };
import { loadEnvFile } from './_seed-utils.mjs';
import { cloudflareRequest, resolveToken, resolveZoneId } from './cloudflare-cache-rule.mjs';

const FIREWALL_PHASE = 'http_request_firewall_custom';
const CACHE_PHASE = 'http_request_cache_settings';
const BLOCK_RULES = ['Block API Bots', 'Block Scriptlike UAs'];

export function buildAgentMarkdownCacheRule() {
  const agents = policy.userAgents.map((ua) => `lower(http.user_agent) contains ${JSON.stringify(ua.toLowerCase())}`);
  return {
    ref: 'www_agent_markdown_cache_bypass',
    description: 'Agent homepage Markdown - bypass shared HTML cache',
    expression: `(http.host in {"worldmonitor.app" "www.worldmonitor.app"} and http.request.uri.path eq "/" and http.request.method in {"GET" "HEAD"} and (${agents.join(' or ')}))`,
    action: 'set_cache_settings',
    action_parameters: { cache: false },
    enabled: true,
  };
}

export function planAgentReadiness(firewall, cache) {
  const changes = [];
  for (const description of BLOCK_RULES) {
    const matches = firewall.rules.filter((rule) => rule.description === description);
    if (matches.length !== 1 || matches[0].action !== 'block' || matches[0].enabled === false) {
      throw new Error(`Expected one enabled block rule named ${description}`);
    }
    const rule = matches[0];
    const response = {
      status_code: 403,
      content_type: 'application/json',
      content: JSON.stringify(policy.blockedResponse),
    };
    if (!isDeepStrictEqual(rule.action_parameters?.response, response)) {
      const definition = Object.fromEntries(Object.entries(rule).filter(([key]) =>
        !['id', 'version', 'last_updated'].includes(key)));
      changes.push({
        phase: FIREWALL_PHASE, rulesetId: firewall.id, ruleId: rule.id,
        description, method: 'PATCH',
        body: { ...definition, action_parameters: { ...rule.action_parameters, response } },
      });
    }
  }

  const desired = buildAgentMarkdownCacheRule();
  const matches = cache.rules.filter((rule) => rule.ref === desired.ref || rule.description === desired.description);
  if (matches.length > 1) throw new Error('Multiple agent Markdown cache rules exist');
  const existing = matches[0];
  if (existing && existing.ref !== desired.ref) throw new Error('Agent Markdown cache rule has an unexpected ref');
  const matchesDesired = existing && Object.entries(desired).every(([key, value]) =>
    isDeepStrictEqual(existing[key], value));
  // Cloudflare ignores Vary: User-Agent. This rule must run after every rule
  // that can enable the homepage cache, including the WWW entry HTML rule.
  if (!matchesDesired || cache.rules.at(-1)?.id !== existing?.id) {
    changes.push({
      phase: CACHE_PHASE, rulesetId: cache.id, ruleId: existing?.id,
      description: desired.description, method: existing ? 'PATCH' : 'POST',
      body: { ...desired, position: { after: '' } },
    });
  }
  return changes;
}

export async function runAgentReadiness(mode, { env = process.env, fetchImpl } = {}) {
  if (!['--plan', '--check', '--apply'].includes(mode)) throw new Error('Use --plan, --check, or --apply');
  const token = resolveToken(env);
  const zoneId = await resolveZoneId(token, { env, fetchImpl });
  const read = (phase) => cloudflareRequest(`/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, { token, fetchImpl });
  const [firewall, cache] = await Promise.all([read(FIREWALL_PHASE), read(CACHE_PHASE)]);
  const changes = planAgentReadiness(firewall, cache);
  if (mode !== '--apply' || changes.length === 0) return { zone: 'worldmonitor.app', ready: changes.length === 0, changes };

  for (const change of changes) {
    const current = await read(change.phase);
    const baseline = change.phase === FIREWALL_PHASE ? firewall : cache;
    if (!isDeepStrictEqual(current.rules, baseline.rules)) {
      throw new Error('Cloudflare rules changed after planning. Run --plan again before applying.');
    }
    const rulePath = change.ruleId ? `/${change.ruleId}` : '';
    const updated = await cloudflareRequest(`/zones/${zoneId}/rulesets/${change.rulesetId}/rules${rulePath}`, {
      token, fetchImpl, method: change.method, body: change.body,
    });
    baseline.rules = updated.rules;
  }
  const remaining = planAgentReadiness(await read(FIREWALL_PHASE), await read(CACHE_PHASE));
  if (remaining.length) throw new Error('Cloudflare verification failed after apply');
  return { zone: 'worldmonitor.app', ready: true, applied: changes.map((change) => change.description) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['--plan', '--check', '--apply'].includes(mode)) {
    console.error('Usage: node scripts/cloudflare-agent-readiness.mjs --plan|--check|--apply');
    process.exitCode = 1;
  } else {
    loadEnvFile(import.meta.url, { only: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ALL_ACCESS_TOKEN', 'CLOUDFLARE_ZONE_ID'] });
    runAgentReadiness(mode).then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (mode === '--check' && !result.ready) process.exitCode = 1;
    }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
