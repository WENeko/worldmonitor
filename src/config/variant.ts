/**
 * Every variant a user can switch to. One desktop binary ships and switches
 * between all of these in-app (#5908), so this list is also the set
 * `/api/download` accepts — `tests/desktop-one-binary-model.test.mjs` fails if
 * the two drift apart.
 */
export const SITE_VARIANTS = ['full', 'tech', 'finance', 'happy', 'commodity', 'energy'] as const;

export type SiteVariant = (typeof SITE_VARIANTS)[number];

export function isSiteVariant(value: string | null | undefined): value is SiteVariant {
  return typeof value === 'string' && (SITE_VARIANTS as readonly string[]).includes(value);
}

const buildVariant = (() => {
  try {
    return import.meta.env.VITE_VARIANT || 'full';
  } catch {
    return 'full';
  }
})();

function loadStoredVariant(): string | null {
  try {
    return localStorage.getItem('worldmonitor-variant');
  } catch {
    return null;
  }
}

export const SITE_VARIANT: string = (() => {
  if (typeof window === 'undefined') return buildVariant;

  const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
  if (isTauri) {
    const stored = loadStoredVariant();
    if (isSiteVariant(stored)) return stored;
    return buildVariant;
  }

  // window.location, not bare `location`: node-based tests stub `window`
  // without a global `location`, and this module must stay importable there.
  const h = window.location?.hostname;
  if (!h) return buildVariant;
  if (h.startsWith('tech.')) return 'tech';
  if (h.startsWith('finance.')) return 'finance';
  if (h.startsWith('happy.')) return 'happy';
  if (h.startsWith('commodity.')) return 'commodity';
  if (h.startsWith('energy.')) return 'energy';

  // [fork-patch] Any host other than the upstream worldmonitor.app deployment
  // (self-hosted, Vercel preview, custom domain) uses local variant selection:
  // an explicit ?variant= URL param wins, then localStorage, then the build
  // default — exactly like localhost / the desktop app.
  const onUpstreamHost =
    h === 'worldmonitor.app' ||
    h === 'www.worldmonitor.app' ||
    h.endsWith('.worldmonitor.app');
  if (h === 'localhost' || h === '127.0.0.1' || !onUpstreamHost) {
    try {
      const urlVariant = new URLSearchParams(window.location.search).get('variant');
      if (isSiteVariant(urlVariant)) return urlVariant;
    } catch { /* ignore */ }
    const stored = loadStoredVariant();
    if (isSiteVariant(stored)) return stored;
    return buildVariant;
  }

  return 'full';
})();
