// Narrative-depth contract for the /compare/ family (#7743).
//
// The 13 comparison pages already have the containers engines look for.
// This file asserts they also have content: no empty keyword H2s, no
// verbatim paragraph repeats, enough unique prose, and FAQ depth.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Window } from 'happy-dom';

import {
  COMPARISON_PAGES,
  writeComparisonPages,
} from '../scripts/build-comparison-pages.mjs';

/** Empty keyword H2s were 0 following characters. A real paragraph clears this. */
const MIN_H2_FOLLOWING_CHARS = 80;
const MIN_VS_UNIQUE_PROSE_WORDS = 1200;
const MIN_MULTI_UNIQUE_PROSE_WORDS = 2000;
const MIN_FAQ_COUNT = 8;
const MAX_FAQ_COUNT = 12;
const MIN_DUPLICATE_PARAGRAPH_CHARS = 40;

const VS_SLUGS = new Set([
  'worldmonitor-vs-liveuamap',
  'worldmonitor-vs-acled',
  'worldmonitor-vs-gdelt',
  'worldmonitor-vs-dataminr',
  'worldmonitor-vs-recorded-future',
  'worldmonitor-vs-deepstatemap',
]);

const MULTI_SLUGS = new Set([
  'liveuamap-alternatives',
  'best-geopolitical-risk-dashboards',
  'mcp-servers-for-geopolitical-data',
  'chokepoint-monitoring-tools',
  'free-geopolitical-risk-dashboards',
  'travel-risk-intelligence-vs-assistance',
]);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseDocument(html) {
  const window = new Window();
  window.document.write(html);
  return window.document;
}

function mainEl(html) {
  const main = parseDocument(html).querySelector('main');
  assert.ok(main, 'generated comparison page must have a <main>');
  return main;
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function wordCount(value) {
  const text = normalizeText(value);
  if (!text) return 0;
  return text.split(' ').filter(Boolean).length;
}

function h2Sections(main) {
  const headings = [...main.querySelectorAll('h2')];
  return headings.map((heading) => {
    const parts = [];
    let node = heading.nextElementSibling;
    while (node && node.tagName !== 'H2') {
      parts.push(normalizeText(node.textContent));
      node = node.nextElementSibling;
    }
    const following = parts.filter(Boolean).join(' ');
    return {
      heading: normalizeText(heading.textContent),
      following,
      followingChars: following.length,
    };
  });
}

function visibleParagraphs(main) {
  return [...main.querySelectorAll('p')]
    .map((node) => normalizeText(node.textContent).replace(/^Direct answer:\s*/i, ''))
    .filter((text) => text.length >= MIN_DUPLICATE_PARAGRAPH_CHARS);
}

function duplicateParagraphs(main) {
  const counts = new Map();
  for (const text of visibleParagraphs(main)) {
    counts.set(text, (counts.get(text) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([text, count]) => ({ text, count }));
}

function uniqueProseWordCount(html) {
  const main = mainEl(html).cloneNode(true);
  for (const script of main.querySelectorAll('script')) script.remove();
  for (const table of main.querySelectorAll('table')) table.remove();
  const blocks = [...main.querySelectorAll('p, li, h1, h2, h3')]
    .map((node) => normalizeText(node.textContent))
    .filter(Boolean);
  const seen = new Set();
  const unique = [];
  for (const block of blocks) {
    if (seen.has(block)) continue;
    seen.add(block);
    unique.push(block);
  }
  return wordCount(unique.join(' '));
}

function faqQuestions(main) {
  const faqHeading = [...main.querySelectorAll('h2')]
    .find((node) => normalizeText(node.textContent) === 'Frequently asked questions');
  if (!faqHeading) return [];
  const questions = [];
  let node = faqHeading.nextElementSibling;
  while (node && node.tagName !== 'H2') {
    if (node.tagName === 'H3') questions.push(normalizeText(node.textContent));
    node = node.nextElementSibling;
  }
  return questions;
}

const stubTpl = {
  escapeHtml,
  breadcrumbLd() {
    return { '@type': 'BreadcrumbList' };
  },
  pageDocument({ title, description, body, jsonLd }) {
    const graphs = Array.isArray(jsonLd) ? jsonLd : jsonLd ? [jsonLd] : [];
    const scripts = graphs
      .map((graph) => `<script type="application/ld+json">${JSON.stringify(graph)}</script>`)
      .join('');
    return [
      '<!doctype html><html lang="en"><head>',
      `<title>${escapeHtml(title)}</title>`,
      `<meta name="description" content="${escapeHtml(description)}">`,
      scripts,
      '</head><body><main>',
      body,
      '</main></body></html>',
    ].join('');
  },
};

describe('comparison page narrative depth (#7743)', () => {
  let outDir;
  let hubHtml;
  const pages = new Map();

  before(() => {
    outDir = mkdtempSync(join(tmpdir(), 'wm-compare-narrative-'));
    writeComparisonPages({
      outDir,
      baseUrl: 'https://www.worldmonitor.app',
      tpl: stubTpl,
    });
    hubHtml = readFileSync(join(outDir, 'compare', 'index.html'), 'utf8');
    for (const page of COMPARISON_PAGES) {
      pages.set(
        page.slug,
        readFileSync(join(outDir, 'compare', page.slug, 'index.html'), 'utf8'),
      );
    }
  });

  after(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it('covers the 12 child pages plus the hub', () => {
    assert.equal(COMPARISON_PAGES.length, 12);
    assert.equal(VS_SLUGS.size + MULTI_SLUGS.size, 12);
    for (const page of COMPARISON_PAGES) {
      assert.ok(
        VS_SLUGS.has(page.slug) || MULTI_SLUGS.has(page.slug),
        page.slug + ' must be classified as vs-* or multi-product',
      );
    }
  });

  it('gives every H2 following content, including keyword headings', () => {
    const documents = [
      ['hub', hubHtml],
      ...[...pages.entries()],
    ];
    const empty = [];
    for (const [label, html] of documents) {
      const main = mainEl(html);
      for (const section of h2Sections(main)) {
        if (section.followingChars < MIN_H2_FOLLOWING_CHARS) {
          empty.push(`${label} H2 "${section.heading}" (${section.followingChars} chars)`);
        }
      }
    }
    assert.deepEqual(empty, [], 'empty or stub H2s:\n' + empty.join('\n'));
  });

  it('does not print the same paragraph twice on a page', () => {
    const duplicates = [];
    for (const [slug, html] of pages) {
      for (const dup of duplicateParagraphs(mainEl(html))) {
        duplicates.push(`${slug} repeats (${dup.count}×): ${dup.text.slice(0, 80)}`);
      }
    }
    for (const dup of duplicateParagraphs(mainEl(hubHtml))) {
      duplicates.push(`hub repeats (${dup.count}×): ${dup.text.slice(0, 80)}`);
    }
    assert.deepEqual(duplicates, [], 'verbatim repeats:\n' + duplicates.join('\n'));
  });

  it('replaces the Why-we-win block with copy that is not the Direct answer', () => {
    for (const [slug, html] of pages) {
      const main = mainEl(html);
      const lede = normalizeText(main.querySelector('p.lede')?.textContent);
      const whyHeading = [...main.querySelectorAll('h2')]
        .find((node) => normalizeText(node.textContent).startsWith('Why World Monitor wins'));
      assert.ok(whyHeading, slug + ' must keep the Why-we-win H2');
      const whyBody = normalizeText(whyHeading.nextElementSibling?.textContent);
      assert.ok(whyBody.length > 40, slug + ' Why-we-win body must have prose');
      assert.notEqual(
        whyBody,
        lede.replace(/^Direct answer:\s*/, ''),
        slug + ' must not reuse the Direct answer under Why-we-win',
      );
    }
  });

  it('expands each child FAQ to 8–12 visible questions with matching FAQPage JSON-LD', () => {
    for (const page of COMPARISON_PAGES) {
      const html = pages.get(page.slug);
      const main = mainEl(html);
      const questions = faqQuestions(main);
      assert.ok(
        questions.length >= MIN_FAQ_COUNT && questions.length <= MAX_FAQ_COUNT,
        page.slug + ' FAQ count must be 8–12, got ' + questions.length,
      );
      assert.equal(
        new Set(questions.map((question) => question.toLowerCase())).size,
        questions.length,
        page.slug + ' FAQ questions must be unique',
      );
      const faqLd = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
        .map(([, raw]) => JSON.parse(raw))
        .find((entry) => entry['@type'] === 'FAQPage');
      assert.equal(
        faqLd?.mainEntity?.length,
        questions.length,
        page.slug + ' FAQPage JSON-LD must match visible questions',
      );
    }
  });

  it('keeps the do-not-publish phrases off generated pages', () => {
    const forbidden = /cyber-only|CC-BY-NC|myACLED free tier|Daily event coding|six figures|\$100K|\$300K|Liveuamap[^.]*no public API/i;
    assert.doesNotMatch(hubHtml, forbidden, 'hub');
    for (const [slug, html] of pages) {
      assert.doesNotMatch(html, forbidden, slug);
    }
  });

  it('helps hub readers choose a comparison without exposing publishing internals', () => {
    const main = mainEl(hubHtml);
    assert.equal(
      normalizeText(main.querySelector('p.lede')?.textContent),
      'Compare tools for conflict monitoring, country risk, shipping disruption, and live geopolitical data. Review their prices, data coverage, update frequency, API access, and limitations, then open a detailed comparison for your use case.',
    );

    const howToChoose = h2Sections(main)
      .find((section) => section.heading === 'How to choose a comparison');
    assert.ok(howToChoose, 'hub must include practical selection guidance');
    assert.match(
      howToChoose.following,
      /Start with the task you need to complete\. Compare tools with the same criteria, then consult the named vendor's current documentation for the capabilities that matter to you\./,
    );

    const choices = [
      ['global multi-domain monitoring', 'best-geopolitical-risk-dashboards'],
      ['structured historical conflict research', 'worldmonitor-vs-acled'],
      ['Ukraine frontline detail', 'worldmonitor-vs-deepstatemap'],
      ['programmatic API or MCP access', 'mcp-servers-for-geopolitical-data'],
      ['monitoring versus travel assistance', 'travel-risk-intelligence-vs-assistance'],
    ];
    for (const [need, slug] of choices) {
      const page = COMPARISON_PAGES.find((candidate) => candidate.slug === slug);
      assert.ok(page, `${slug} must remain in the comparison registry`);
      assert.match(howToChoose.following, new RegExp(`${need}[^.]*${page.h1}`, 'i'));
      assert.ok(
        main.querySelector(`a.card[href="${page.path}"]`),
        `${page.h1} must remain available in the hub navigation`,
      );
    }

    const changedCopy = [
      normalizeText(main.querySelector('p.lede')?.textContent),
      howToChoose.following,
    ].join(' ');
    assert.doesNotMatch(
      changedCopy,
      /questions engines|extractable|search[- ]engine|URL construction|vs-\* URLs|content generation|linked (?:product documentation|source links)/i,
    );

    const sections = new Map(h2Sections(main).map((section) => [section.heading, section.following]));
    assert.ok(main.querySelector('table'), 'hub must retain the master comparison matrix');
    assert.ok(sections.get('What we concede on purpose'), 'hub must retain named limitations');
    assert.match(sections.get('How these figures were checked') ?? '', /checked on 5 September 2026/);
    assert.match(
      sections.get('How these figures were checked') ?? '',
      /confirm the current price or capability in the named vendor's documentation before you buy/i,
    );
    assert.doesNotMatch(
      sections.get('How these figures were checked') ?? '',
      /linked vendor page/i,
    );
    assert.match(
      howToChoose.following,
      /Check the detailed comparison's dated methodology, then confirm the current price or capability with the vendor because both can change\./,
    );
  });

  it('puts unique prose in the word-count bands from the GEO audit', () => {
    for (const page of COMPARISON_PAGES) {
      const words = uniqueProseWordCount(pages.get(page.slug));
      const min = VS_SLUGS.has(page.slug)
        ? MIN_VS_UNIQUE_PROSE_WORDS
        : MIN_MULTI_UNIQUE_PROSE_WORDS;
      assert.ok(
        words >= min,
        `${page.slug} unique prose must be >= ${min} words, got ${words}`,
      );
    }
  });
});
