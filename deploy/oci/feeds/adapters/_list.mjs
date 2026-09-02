// _list.mjs — shared HTML news-list extractor for scrape adapters.
//
// Deliberately dependency-free and defensive: government sites that refuse
// RSS rarely keep a stable DOM either, so this parses <li> list blocks for
// (anchor title + href + nearby date) using regex fallbacks instead of a
// selector engine. Nav noise is filtered by minimum title length and junk
// hrefs. Adapters should THROW when they cannot find a recognizable list so
// failures surface in status.json instead of silently writing empty output.
//
// Not loaded as an adapter: no default export (poll-feeds.mjs skips it).

function decode(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function strip(s) {
  return String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

const JUNK_HREF = /^(javascript:|mailto:|tel:|#|data:)/i;
const JUNK_EXT = /\.(css|js|png|jpe?g|gif|svg|webp|ico|pdf|docx?|xlsx?|zip)(\?|$)/i;

// opts: { dateRe (default YYYY/MM/DD or YYYY-MM-DD), minTitleLen (default 10) }
export function extractNewsList(html, pageUrl, opts = {}) {
  const minTitleLen = opts.minTitleLen ?? 10;
  const dateRe = opts.dateRe ?? /(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/g;
  const clean = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const blocks = clean.match(/<li[\s>][\s\S]*?<\/li>/gi) || [];
  const items = [];
  const seen = new Set();
  for (const b of blocks) {
    const anchorRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    let chosen = null;
    while ((m = anchorRe.exec(b)) !== null) {
      const rawHref = decode(m[1]).trim();
      const title = strip(m[2]);
      if (!rawHref || JUNK_HREF.test(rawHref) || JUNK_EXT.test(rawHref)) continue;
      if (title.length < minTitleLen) continue;
      if (rawHref === '/' || rawHref === pageUrl) continue;
      chosen = { title, rawHref };
      break; // first plausible anchor of the block wins
    }
    if (!chosen) continue;
    let published = null;
    dateRe.lastIndex = 0;
    const d = dateRe.exec(b);
    if (d) {
      const y = Number(d[1]); const mo = Number(d[2]); const day = Number(d[3]);
      if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
        published = Date.UTC(y, mo - 1, day);
      }
    }
    let link = chosen.rawHref;
    if (!/^https?:\/\//i.test(link)) {
      try { link = new URL(link, pageUrl).href; } catch { continue; }
    }
    const id = link;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, title: chosen.title, link, published, summary: null });
  }
  return items;
}
