import type { ComputeEnergyShockScenarioResponse } from '@/generated/client/worldmonitor/intelligence/v1/service_client';

export interface DecisionBriefSelection {
  countryCode: string;
  countryName: string;
  chokepointId: string;
  fuelMode: 'gas' | 'oil';
  baselinePct: number;
  comparisonPct: number;
}

export interface DecisionBriefCapture {
  retrievedAt: string;
  response: ComputeEnergyShockScenarioResponse;
}

export interface DecisionBriefSnapshot {
  selection: DecisionBriefSelection;
  capturedAt: string;
  captures: [DecisionBriefCapture, DecisionBriefCapture];
  evidence: { id: string; label: string; value: number | null; unit: string; source: string; sourceUrl: string; observedAt: string | null }[];
  results: { reference: string; severity: number; loss: number | null; unit: string; demandPct: number | null; observedAt: string | null }[];
  comparison: { delta: number | null; reason: string };
  assumptions: string[];
  impact: string;
  action: { text: string; references: string[]; constraint: string; trigger: string };
  unknowns: string[];
}
