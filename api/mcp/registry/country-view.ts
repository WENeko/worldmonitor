import { z } from 'zod';
import { COUNTRY_READERS, countryReaderSchema, countryViewSchema, panelAdmissionSchema } from '../../../shared/country-brief-host';
import { BRIEF_TOPICS } from '../../../shared/country-brief-sections';
import { resolveCountryCode } from '../../../shared/country-code-resolve';
import { buildAuthHeaders } from '../auth';
import { assertToolFetchOk, RpcValidationError, throwIfBillingDenial } from '../billing-denial';
import { fetchMcpDownstream } from '../downstream';
import type { ToolDef } from '../types';
import { COUNTRY_VIEW_UI_URI } from '../ui/news-dashboard-app';

export const COUNTRY_VIEW_TOOLS: ToolDef[] = [{
  name: 'open_country_brief',
  title: 'WorldMonitor country brief',
  _subscriptionOnly: true,
  description: 'Open the interactive WorldMonitor country brief with its assessment, source evidence, resilience, energy, trade and security sections. Use for country brief requests and follow-up topic navigation. On dedicated paid MCP plans, one country request includes its internal section loads. Same-country opens reuse the request for five minutes. Explicit refresh starts a new request. API plans retain per-tool weighted billing. The interface loads sections progressively through the authenticated connection. Section availability and dates are shown in the view. Use get_country_brief only when the user explicitly wants a text assessment.',
  _uiResourceUri: COUNTRY_VIEW_UI_URI,
  _openaiEntrypoints: [{ type: 'global' }, { type: 'thread' }],
  _outputBudgetBytes: 4096,
  _apiPaths: [],
  inputSchema: {
    type: 'object',
    properties: {
      country_code: { type: 'string', minLength: 2, maxLength: 100, description: 'Country name or ISO2 code.' },
      topic: { type: 'string', enum: Object.keys(BRIEF_TOPICS) },
      request_id: { type: 'string', format: 'uuid', description: 'Stable ID for an explicit refresh. Retries with the same ID share one paid admission.' },
      refresh: { type: 'boolean', description: 'Start a new paid panel request and refresh loaded observations. Default false reuses the current same-country request.' },
    },
    required: ['country_code'],
  },
  outputSchema: {
    type: 'object',
    properties: { countryCode: { type: 'string' }, topic: { type: 'string', enum: Object.keys(BRIEF_TOPICS) }, panelRequest: z.toJSONSchema(panelAdmissionSchema) },
    required: ['countryCode', 'topic'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _execute: async (params, _base, _context, execution) => {
    const parsed = countryViewSchema.safeParse(Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'jmespath')));
    const countryCode = parsed.success ? resolveCountryCode(parsed.data.country_code) : null;
    if (!parsed.success || !countryCode) throw new RpcValidationError('open_country_brief', [{ field: 'country_code', description: 'Supply a recognized country and topic.' }]);
    return { countryCode, topic: parsed.data.topic, ...(execution?.countryPanel ? { panelRequest: execution.countryPanel } : {}) };
  },
}, {
  name: 'get_country_brief_section',
  description: 'Read one fixed country-view dataset for the embedded country brief. The section chooses a reviewed reader and its bounded arguments. Returns a ready, locked or unavailable state. Native observation dates remain in value; retrievedAt only records retrieval. Does not accept URLs, headers or arbitrary RPC paths.',
  _subscriptionOnly: true,
  _weight: 2,
  _outputBudgetBytes: 524288,
  _apiPaths: [...new Set(Object.values(COUNTRY_READERS).filter(reader => reader.path !== '/api/bootstrap').map(reader => `GET ${reader.path}`))],
  inputSchema: {
    type: 'object',
    properties: {
      panel_request: { type: 'string', maxLength: 160, description: 'Server-issued paid country-panel request token. Only the embedded country view supplies this.' },
      section: { type: 'string', enum: Object.keys(COUNTRY_READERS) },
      arguments: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
    },
    required: ['section'],
    oneOf: Object.entries(COUNTRY_READERS).map(([section, reader]) => ({
      properties: { section: { const: section }, arguments: z.toJSONSchema(reader.args) },
    })),
  },
  outputSchema: {
    type: 'object',
    properties: {
      state: { type: 'string', enum: ['ready', 'locked', 'unavailable'] },
      section: { type: 'string', enum: Object.keys(COUNTRY_READERS) },
      value: { type: 'object' }, retrievedAt: { type: 'string' }, reason: { type: 'string' },
    },
    required: ['state', 'section'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  _execute: async (params, base, context, execution) => {
    const parsed = countryReaderSchema.safeParse(Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'jmespath')));
    if (!parsed.success) throw new RpcValidationError('get_country_brief_section', [{ field: 'section', description: 'Unknown country section reader.' }]);
    const { section } = parsed.data;
    const reader = COUNTRY_READERS[section];
    const args = reader.args.safeParse(parsed.data.arguments);
    if (!args.success) throw new RpcValidationError('get_country_brief_section', [{ field: 'arguments', description: 'Invalid arguments for this country section.' }]);
    const query = new URLSearchParams(Object.entries(args.data).map(([key, value]) => [key, String(value)]));
    const url = `${base}${reader.path}${query.size ? `?${query}` : ''}`;
    const headers = await buildAuthHeaders(context, 'GET', url, null);
    const response = await fetchMcpDownstream(url, { headers: { ...headers, 'User-Agent': 'WorldMonitor-MCP/1.0' }, signal: AbortSignal.timeout(15_000) }, execution);
    throwIfBillingDenial(response, section);
    if (response.status === 401 || response.status === 403) return { state: 'locked', section, reason: 'This connection is not authorized for this section.' };
    await assertToolFetchOk(response, section, { preserveBackoff: true });
    return { state: 'ready', section, value: await response.json(), retrievedAt: new Date().toISOString() };
  },
}];
