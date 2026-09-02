// pboc.mjs — scrape adapter for PBoC English announcements.
//
// EXPERIMENTAL: the People's Bank of China English site publishes no RSS and
// is often behind anti-bot filtering (may need the OREF-style workarounds the
// upstream repo uses for gov.cn). Parsing is the same defensive <li> list
// extractor as taiwan-mnd; zero items -> throw, so failures surface in
// status.json. Validate with `node poll-feeds.mjs --check` on the VM before
// enabling the source in sources.json.
//
// Adapter contract (see poll-feeds.mjs): default export is the adapter
// function; returns { id, title, link, published (epoch ms | null), summary }[].

import { extractNewsList } from './_list.mjs';

async function pboc(src, helpers) {
  const html = await helpers.fetch(src.url);
  const items = extractNewsList(html, src.url, {
    minTitleLen: 10,
    dateRe: /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/g,
  });
  if (items.length === 0) {
    throw new Error('no recognizable announcement list found (site layout or bot filter?) — update adapters/pboc.mjs');
  }
  return items.slice(0, src.scrape?.maxItems ?? 10);
}

export default pboc;
