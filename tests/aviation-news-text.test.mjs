import { it } from 'node:test';
import assert from 'node:assert/strict';
import { seedAviationNews } from '../scripts/seed-aviation.mjs';

it('publishes a plain-text snippet with exactly one HTML entity layer decoded', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('<rss><channel><item><title>Flight news</title><link>https://example.org/news</link><description><![CDATA[<p>AT&amp;T &lt;flight&gt; &amp;lt;literal&amp;gt;</p>]]></description></item></channel></rss>');
  try {
    const result = await seedAviationNews();
    assert.ok(result.items.length > 0);
    assert.equal(result.items[0].snippet, 'AT&T <flight> &lt;literal&gt;');
  } finally {
    globalThis.fetch = original;
  }
});
