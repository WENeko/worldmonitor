import commodityRegistry from '../../scripts/shared/supply-vulnerability-commodities.json';
import { computeSupplierRouteRisk } from './supplier-route-risk';
import type { CommodityBriefCapture, CommodityBriefSelection, CommodityBriefSnapshot } from '../types/decision-brief';
import type { DecisionBriefCapture, DecisionBriefSelection, DecisionBriefSnapshot } from '../types/decision-brief';

const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const month = (value: string | undefined): string | null => value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null;

export function buildDecisionBrief(selection: DecisionBriefSelection, captures: [DecisionBriefCapture, DecisionBriefCapture]): DecisionBriefSnapshot {
  const evidence: DecisionBriefSnapshot['evidence'] = [];
  const unknowns = new Set<string>();
  const gas = selection.fuelMode === 'gas';
  const results = captures.map(({ response: r }, index) => {
    const reference = index === 0 ? 'baseline' : 'comparison';
    const severity = index === 0 ? selection.baselinePct : selection.comparisonPct;
    const identity = r.countryCode === selection.countryCode && r.chokepointId === selection.chokepointId && r.disruptionPct === severity;
    const g = r.gasSensitivity;
    const observedAt = gas ? month(g?.dataMonth) : null;
    const usable = identity && (gas
      ? !r.gasImpact && g?.dataAvailable === true && g.modelBasis === 'assumed_route_sensitivity' && nonnegative(g.lngImportsTj) && nonnegative(g.totalDemandTj) && g.totalDemandTj > 0 && nonnegative(g.lngDisruptionTj) && nonnegative(g.deficitPct)
      : r.dataAvailable && r.jodiOilCoverage && nonnegative(r.crudeLossKbd));
    if (!identity) unknowns.add(`${reference}: response does not match the selected country, route and severity.`);
    if (!observedAt) unknowns.add(`${reference}: observation date is unknown.`);
    if (!usable) unknowns.add(gas ? `${reference}: recover recorded LNG imports, positive gas demand and a supported gas model for ${selection.countryCode}.` : `${reference}: recover the oil import and demand baseline for ${selection.countryCode}.`);
    const add = (suffix: string, label: string, value: number | null, unit: string, source: string, date = observedAt) => evidence.push({ id: `${reference}-${suffix}`, label, value, unit, source, sourceUrl: source.startsWith('JODI') ? 'https://www.jodidata.org/' : source === 'GIE' ? 'https://agsi.gie.eu/' : 'https://comtradeplus.un.org/', observedAt: date });
    if (gas) {
      add('lng', 'Recorded LNG imports', identity && g?.dataAvailable && nonnegative(g.lngImportsTj) ? g.lngImportsTj : null, 'TJ', 'JODI');
      add('demand', 'Recorded gas demand', identity && g?.dataAvailable && nonnegative(g.totalDemandTj) && g.totalDemandTj > 0 ? g.totalDemandTj : null, 'TJ', 'JODI');
      if (identity && g?.storage) {
        const s = g.storage;
        add('storage', 'National gas storage (context only)', nonnegative(s.gasTwh) ? s.gasTwh : null, 'TWh', 'GIE', s.date || null);
        unknowns.add('Accessible storage and withdrawal capacity are unknown; storage is excluded from the comparison.');
      }
    } else {
      add('route', 'Comtrade-backed crude route share', usable && r.comtradeCoverage && nonnegative(r.gulfCrudeShare) ? r.gulfCrudeShare * 100 : null, '%', 'UN Comtrade / route model');
      if (identity && !r.comtradeCoverage) unknowns.add(`${reference}: Comtrade route exposure is unavailable; the oil loss model uses a fixed proxy share.`);
    }
    add('loss', gas ? 'Assumed monthly LNG loss' : 'Modeled crude loss', usable ? gas ? g!.lngDisruptionTj : r.crudeLossKbd : null, gas ? 'TJ' : 'kbd', gas ? 'JODI / assumed route sensitivity' : 'JODI / route model');
    if (!r.portwatchCoverage) unknowns.add(`${reference}: shipping traffic is unavailable; no closure is established.`);
    return { reference, severity, loss: usable ? gas ? g!.lngDisruptionTj : r.crudeLossKbd : null, unit: gas ? 'TJ' : 'kbd', demandPct: usable && gas ? g!.deficitPct : null, observedAt };
  });
  const a = captures[0].response.gasSensitivity;
  const b = captures[1].response.gasSensitivity;
  // `a.modelBasis === b.modelBasis` is defence in depth only: a non-null loss implies
  // `usable`, which already pins each capture's modelBasis to the same literal, so this
  // conjunct cannot currently be false. The `dataSource` terms are NOT implied by
  // `usable` and are load-bearing; note the non-empty check reads the baseline capture
  // only, which is why the tests mutate captures[0] and captures[1] separately.
  const comparable = gas && results.every(r => r.loss !== null && r.observedAt !== null) && a && b &&
    a.modelBasis === b.modelBasis && typeof a.dataSource === 'string' && a.dataSource.length > 0 && a.dataSource === b.dataSource && a.dataMonth === b.dataMonth &&
    a.lngImportsTj === b.lngImportsTj && a.totalDemandTj === b.totalDemandTj && a.lngShareOfImports === b.lngShareOfImports;
  const positive = results[0]!.loss !== null && results[0]!.loss! > 0;
  const missing = results[0]!.loss === null;
  const constraint = gas
    ? 'Country-specific supplier and route exposure, available alternative supply, prices and lead times are unknown.'
    : 'Modeled route exposure does not establish available alternative supply, prices or lead times.';
  return {
    selection: { ...selection }, capturedAt: captures[0].retrievedAt > captures[1].retrievedAt ? captures[0].retrievedAt : captures[1].retrievedAt, captures: structuredClone(captures), evidence, results,
    comparison: { delta: comparable ? results[1]!.loss! - results[0]!.loss! : null, reason: comparable ? 'Common country, route, model, observation month, LNG inputs and demand. Storage is context only.' : 'Numeric delta withheld: evidence bases differ or provenance is unknown. Refresh both results and check their observation dates.' },
    assumptions: gas ? [...captures.flatMap(({ response }) => response.countryCode === selection.countryCode && response.chokepointId === selection.chokepointId && response.gasSensitivity?.modelBasis === 'assumed_route_sensitivity' && !response.gasImpact && response.gasSensitivity.assessment ? [response.gasSensitivity.assessment] : []), 'Assumed route sensitivity; the route fraction is fixed by the existing model, not measured country-specific supplier exposure.', 'Monthly sensitivity only. No physical deficit, operational endurance or 14-day forecast is estimated.', 'Shipping traffic and storage do not scale this gas calculation.'] : ['Oil loss uses the existing route model. Observation dates are unavailable; no numeric comparison is supported.'],
    impact: gas ? 'If the assumed route exposure applies, a disruption reduces the modeled portion of recorded monthly LNG imports. The demand ratio is context, not a forecast of unmet demand.' : 'If the modeled crude route exposure applies, disruption reduces modeled crude flow. Actual obligations and substitution remain unverified.',
    action: {
      text: missing ? `Recover ${gas ? 'recorded LNG imports, positive gas demand and the supported model basis' : 'the oil import and demand baseline'} for ${selection.countryName}. Withhold a procurement conclusion until these inputs are available.` : positive ? `Compare ${selection.countryName}'s supply obligations and alternative origins against the modeled loss before considering procurement changes.` : `Verify ${selection.countryName}'s actual route exposure and supply obligations before treating the modeled zero as low risk.`,
      references: gas ? ['baseline-lng', 'baseline-demand', 'baseline-loss'] : ['baseline-route', 'baseline-loss'],
      constraint: missing ? `The baseline is incomplete. ${constraint}` : constraint,
      trigger: missing ? 'Reassess when the named baseline inputs and their observation dates are recovered.' : 'Reassess when updated source observations or verified supplier, route and delivery obligations change the assumed exposure.',
    },
    unknowns: [...unknowns, constraint, 'Retrieval time does not establish freshness. Review each observation date before acting.'],
  };
}

export const COMMODITY_BRIEF_OPTIONS = commodityRegistry.commodities;

export function buildCommodityBrief(selection: CommodityBriefSelection, input: CommodityBriefCapture): CommodityBriefSnapshot {
  const commodity = COMMODITY_BRIEF_OPTIONS.find(c => c.id === selection.commodityId);
  if (!commodity) throw new Error('Unsupported commodity selection');
  if (input.products.iso2 !== selection.countryCode || input.vulnerabilities.iso2 !== selection.countryCode) {
    throw new Error('Commodity evidence country does not match selection');
  }
  const capture = structuredClone(input);
  const hs4 = commodity.hs4[0]!;
  const product = capture.products.products.find(p => p.hs4 === hs4);
  const observedAt = product && Number.isInteger(product.year) && product.year >= 1900 && product.year <= 2100 ? String(product.year) : null;
  const evidence: CommodityBriefSnapshot['evidence'] = [];
  const constraints = 'Spare capacity, qualification, price and lead time are unknown. Confirm usable material, transport mode and delivery terms with a qualified supplier.';
  const caveats = [commodity.mappingCaveat,
    'Recorded trade is a customs-heading observation, not a qualified supplier or proof of spare capacity. Shares are by import value, not physical volume.',
    'Routes are geographic models, not observed shipments. Only the selected chokepoint is assumed blocked; other disruptions and transport modes are unknown.',
    'A downstream Suez or Cape option cannot bypass an origin blocked at the Strait of Hormuz.'];
  if (hs4 === '2804') caveats.push('Helium uses the HS 2804 commodity-basket proxy, which includes other gases. It cannot establish a hospital helium supplier share.');
  const seen = new Set<string>();
  const candidates: CommodityBriefSnapshot['candidates'] = [];
  for (const exp of product?.topExporters ?? []) {
    if (!/^[A-Z]{2}$/.test(exp.partnerIso2) || exp.partnerIso2 === selection.countryCode || seen.has(exp.partnerIso2)) continue;
    seen.add(exp.partnerIso2);
    const sharePct = nonnegative(exp.share) && exp.share <= 1 ? exp.share * 100 : null;
    const shareReference = `share-${selection.countryCode}-${hs4}-${exp.partnerIso2}`;
    evidence.push({ id: shareReference, label: `${exp.partnerIso2} recorded share of HS ${hs4} imports`, value: sharePct, unit: '% of import value', source: 'UN Comtrade bilateral HS4', sourceUrl: 'https://comtradeplus.un.org/', observedAt });
    const route = computeSupplierRouteRisk(exp.partnerIso2, selection.countryCode, new Map());
    const affectedChokepoints = route.transitChokepoints.filter(cp => cp.chokepointId === selection.chokepointId).map(cp => cp.chokepointId);
    const routeState = route.routeIds.length === 0 ? 'unknown' : affectedChokepoints.length ? 'exposed' : 'not_on_modeled_route';
    const reason = routeState === 'unknown'
      ? 'No modeled route for this country pair. Validate the transport path before comparing route exposure.'
      : routeState === 'exposed'
        ? 'Modeled route includes the selected blocked chokepoint. A downstream detour does not establish an origin bypass.'
        : 'Selected chokepoint is absent from the modeled path. This supports investigating the origin, not a safe-route or availability conclusion.';
    candidates.push({ origin: exp.partnerIso2, shareReference, sharePct, routeIds: route.routeIds,
      transitChokepoints: route.transitChokepoints.map(cp => cp.chokepointId), affectedChokepoints, routeState, reason, constraints });
  }
  const order = { not_on_modeled_route: 0, unknown: 1, exposed: 2 };
  candidates.sort((a, b) => order[a.routeState] - order[b.routeState] || (b.sharePct ?? -1) - (a.sharePct ?? -1) || a.origin.localeCompare(b.origin));
  const candidate = candidates.find(c => c.routeState !== 'exposed' && c.sharePct !== null && c.sharePct > 0);
  const vulnerability = !capture.vulnerabilities.upstreamUnavailable
    ? capture.vulnerabilities.vulnerabilities.find(v => v.countryIso2 === selection.countryCode && v.commodityId === commodity.id) : undefined;
  const context = vulnerability
    ? `Commodity vulnerability: ${vulnerability.state}; band: ${vulnerability.band || 'unknown'}. Coverage: ${vulnerability.coverage.join(', ') || 'unknown'}. This context does not establish bilateral supplier shares.`
    : 'Commodity vulnerability context is unavailable for this selection. No zero exposure is inferred.';
  const missing = !product ? `No recorded HS ${hs4} bilateral product evidence is available for ${selection.countryName}.`
    : candidates.length === 0 ? 'No recorded exporter-country rows are available.'
      : candidates.every(c => c.routeState === 'exposed') ? 'Every modeled candidate route includes the selected blocked chokepoint.'
        : 'No positive recorded share supports an alternative origin.';
  const action = candidate ? {
    text: `Investigate recorded ${candidate.origin} supply for ${selection.countryName}'s ${commodity.label} question. ${candidate.reason}`,
    references: [candidate.shareReference], constraint: constraints,
    trigger: `Reassess when ${candidate.origin}'s actual route, usable capacity, qualification, price or delivery date is confirmed, or the recorded trade evidence changes.`,
  } : {
    text: `${missing} Recover the missing bilateral evidence or validate an origin route before a procurement conclusion.`,
    references: evidence.map(e => e.id), constraint: `${missing} ${constraints}`,
    trigger: 'Reassess when positive bilateral supplier evidence and a usable origin route are available, or the selected chokepoint reopens.',
  };
  return { kind: 'commodity', selection: { ...selection }, capturedAt: capture.retrievedAt, commodity: commodity.label, hs4, capture,
    evidence, candidates, context, caveats,
    ordering: 'Investigation order: selected chokepoint absent from modeled path, unknown route, then exposed route; within each group, descending recorded import-value share. This is not a supplier recommendation score.', action };
}
