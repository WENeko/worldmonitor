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
