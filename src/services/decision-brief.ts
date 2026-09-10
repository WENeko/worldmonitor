import { IntelligenceServiceClient } from '@/services/generated-rpc-clients';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { premiumFetch } from '@/services/premium-fetch';
import type { DecisionBriefCapture, DecisionBriefSelection } from '@/types/decision-brief';

const client = new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });

export async function captureDecisionBrief(selection: DecisionBriefSelection, signal: AbortSignal): Promise<[DecisionBriefCapture, DecisionBriefCapture]> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const capture = async (disruptionPct: number): Promise<DecisionBriefCapture> => ({
    response: await client.computeEnergyShockScenario({ countryCode: selection.countryCode, chokepointId: selection.chokepointId, fuelMode: selection.fuelMode, disruptionPct }, { signal: requestSignal }),
    retrievedAt: new Date().toISOString(),
  });
  return Promise.all([capture(selection.baselinePct), capture(selection.comparisonPct)]);
}
