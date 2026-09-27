import { expect, it, vi } from 'vitest';
import type { PizzIntStatus } from '@/types';

vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));

import { PizzIntIndicator } from '@/components/PizzIntIndicator';

it('switches source attribution during fallback and restores it on recovery', () => {
  const indicator = new PizzIntIndicator();
  const status: PizzIntStatus = {
    defconLevel: 3, defconLabel: 'Elevated Activity', aggregateActivity: 60,
    activeSpikes: 0, locationsMonitored: 1, locationsOpen: 1,
    lastUpdate: new Date(), dataFreshness: 'fresh',
    locations: [{
      place_id: 'venue', name: 'Pizza', address: '', current_popularity: 60,
      percentage_of_usual: null, is_spike: false, spike_magnitude: 0,
      data_source: 'besttime', recorded_at: new Date().toISOString(),
      data_freshness: 'fresh', is_closed_now: false,
    }],
  };
  const source = () => indicator.getElement().querySelector<HTMLAnchorElement>('.pizzint-source a')!;
  indicator.updateStatus(status);
  expect(source().textContent).toBe('BestTime');
  expect(source().href).toBe('https://besttime.app/');
  indicator.updateStatus({ ...status, locations: status.locations.map(loc => ({ ...loc, data_source: 'google' })) });
  expect(source().textContent).toBe('PizzINT');
  expect(source().href).toBe('https://www.pizzint.watch/');
});
