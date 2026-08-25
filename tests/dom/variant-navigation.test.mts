import { describe, expect, it } from 'vitest';

import {
  VARIANT_SWITCHER_DASHBOARD_URLS,
  variantSwitcherHref,
} from '@/app/panel-layout';

describe('variant switcher navigation', () => {
  it('sends every non-local variant switcher target to its dashboard route on upstream hosts', () => {
    window.location.hostname = 'worldmonitor.app';
    for (const [variant, expected] of Object.entries(VARIANT_SWITCHER_DASHBOARD_URLS)) {
      expect(
        variantSwitcherHref(
          variant as keyof typeof VARIANT_SWITCHER_DASHBOARD_URLS,
          variant === 'full' ? 'tech' : 'full',
          false,
        ),
      ).toBe(expected);
      expect(new URL(expected).pathname).toBe('/dashboard');
    }
    window.location.hostname = 'localhost';
  });

  it('does not navigate for local development or the active variant', () => {
    expect(variantSwitcherHref('tech', 'full', true)).toBe('#');
    expect(variantSwitcherHref('tech', 'tech', false)).toBe('#');
  });

  it('on non-upstream hosts, cross-variant targets become same-origin ?variant= links', () => {
    window.location.hostname = 'worldmonitor-git-vercel-worldmonitor-weneko.vercel.app';
    for (const [variant] of Object.entries(VARIANT_SWITCHER_DASHBOARD_URLS)) {
      expect(
        variantSwitcherHref(
          variant as keyof typeof VARIANT_SWITCHER_DASHBOARD_URLS,
          variant === 'full' ? 'tech' : 'full',
          false,
        ),
      ).toBe(`?variant=${variant}`);
    }
    window.location.hostname = 'localhost';
  });
});
