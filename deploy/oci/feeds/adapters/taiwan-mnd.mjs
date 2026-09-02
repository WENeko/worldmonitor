// taiwan-mnd.mjs — scrape adapter for Taiwan MND English press releases.
//
// EXPERIMENTAL: the MND site publishes no RSS and its markup is not stable.
// The adapter is defensive by construction (see _list.mjs) and THROWS when
// it cannot recognize a news list, so a layout change surfaces as an error
// in status.json instead of silently writing empty sector files.
//
// Adapter contract (see poll-feeds.mjs): default export is the adapter
// function; it receives (src, helpers) and returns an array of items with
// { id, title, link, published (epoch ms | null), summary }. The file stem
// MUST match the scrape.adapter value in sources.json ("taiwan-mnd").
//
// Validate live on the VM before enabling the source:
//   node poll-feeds.mjs --check   (source must be state: active)

import { extractNewsList } from './_list.mjs';

async function taiwanMnd(src, helpers) {
  const html = await helpers.fetch(src.url);
  const items = extractNewsList(html, src.url, {
    minTitleLen: 12, // MND titles are long; nav labels ("About Us", …) are short
    dateRe: /(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/g,
  });
  if (items.length === 0) {
    throw new Error('no recognizable news list found (site layout changed?) — update adapters/taiwan-mnd.mjs');
  }
  return items.slice(0, src.scrape?.maxItems ?? 10);
}

export default taiwanMnd;
