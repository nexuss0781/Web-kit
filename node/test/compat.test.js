import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { v2Search, v2Scrape, v2DeveloperSearch } from '../src/compat.js';

/** A local upstream, so these tests assert what we send and not what it says. */
async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function json(handler) {
  return (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      handler({ req, body, send: (payload) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      } });
    });
  };
}

test('search asks the general index, folds domains in, and keeps the groups apart', async () => {
  let seen = null;
  const upstream = await serve(json(({ body, send }) => {
    seen = body;
    send({
      success: true,
      data: {
        web: [{ url: 'https://docs.rs/x', title: 'Docs', description: 'about x', position: 1 }],
        news: [{ url: 'https://news.test/x', title: 'News', description: 'today', position: 1 }],
        images: [{ url: 'https://img.test/x.png', title: 'Picture', position: 1 }],
      },
    });
  }));

  try {
    const answer = await v2Search({
      query: 'rust async',
      limit: 3,
      sources: ['web', 'news'],
      includeDomains: ['https://www.docs.rs/a/b'],
      excludeDomains: ['spam.test'],
      tbs: 'qdr:w',
    }, { firecrawlApiUrl: upstream.base, searchTimeoutMs: 2000, keylessFirecrawl: true, searchTiers: ['firecrawl-keyless'] });

    assert.equal(answer.success, true);
    assert.match(answer.id, /^search_/, 'a search carries an id, like the real one');
    // Both restrictions are clauses, because that is the one form every tier
    // understands and there is no domain parameter to pass instead.
    assert.match(seen.query, /site:docs\.rs/);
    assert.match(seen.query, /-site:spam\.test/);
    // Both groups are named, web included: `sources` replaces the default, so
    // omitting web would silently drop the general results.
    assert.deepEqual(seen.sources, [{ type: 'web' }, { type: 'news' }]);
    assert.equal(seen.tbs, 'qdr:w');
    assert.equal(seen.limit, 3);

    assert.equal(answer.data.web.length, 1);
    assert.equal(answer.data.news.length, 1);
    assert.equal(answer.data.images, undefined, 'a group nobody asked for is absent, not empty');
  } finally {
    await upstream.close();
  }
});

test('a filter the index rejects is dropped before the search is', async () => {
  // Losing the general index over an optional parameter would turn a good query
  // into a vertical-only one, so the retry keeps the query and drops the rest.
  const bodies = [];
  const upstream = await serve(json(({ body, send }) => {
    bodies.push(body);
    if (bodies.length === 1) {
      send({ success: false, error: 'Invalid request body' });
      return;
    }
    send({ success: true, data: { web: [{ url: 'https://a.test/1', title: 'A' }] } });
  }));

  try {
    const answer = await v2Search({ query: 'x', limit: 2, categories: ['research'] }, {
      firecrawlApiUrl: upstream.base,
      searchTimeoutMs: 2000,
      keylessFirecrawl: true,
      searchTiers: ['firecrawl-keyless'],
    });

    assert.equal(bodies.length, 2, 'the first attempt failed, the second was tried');
    assert.deepEqual(bodies[1], { query: 'x', limit: 2 }, 'the retry carries only what must be carried');
    assert.equal(answer.data.web[0].url, 'https://a.test/1');
  } finally {
    await upstream.close();
  }
});

test('a dead index falls through to the local providers instead of failing the search', async () => {
  // The fallback provider is a mock SearXNG, so this asserts the handoff
  // without reaching the network.
  const instance = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ title: 'Local hit', url: 'https://local.test/page', content: 'from the verticals' }],
    }));
  });

  try {
    const answer = await v2Search({ query: 'anything', limit: 5 }, {
      firecrawlApiKey: 'fc-k',
      firecrawlApiUrl: 'http://127.0.0.1:1',
      // The keyed tier is the point here; leaving keyless on would make this
      // test trip the cooldown for the shared upstream address.
      keylessFirecrawl: false,
      searchTimeoutMs: 500,
      searxngUrls: [instance.base],
      // One provider named, so the assertion is about the handoff and not about
      // whatever else the default set would have asked.
      providers: ['searxng'],
      searchTiers: ['searxng', 'firecrawl-key'],
    });

    assert.equal(answer.success, true);
    assert.equal(answer.tiers_tried[0], 'searxng', 'the local instance is the first tier and it answered');
    assert.ok(answer.warnings?.some((line) => line.startsWith('firecrawl-key:')), 'the dead keyed tier is reported, not hidden');
    assert.equal(answer.data.web.length, 1);
    assert.equal(answer.data.web[0].url, 'https://local.test/page');
    assert.equal(answer.data.web[0].position, 1);
  } finally {
    await instance.close();
  }
});

test('a scrape is answered from one read, and says the copy is not cached', async () => {
  const answer = await v2Scrape({
    url: 'https://example.com/',
    formats: ['markdown', 'links', 'rawHtml'],
  }, { timeoutMs: 10_000, maxBodyBytes: 2_000_000 });

  assert.equal(answer.success, true);
  assert.equal(answer.data.metadata.statusCode, 200);
  assert.equal(answer.data.metadata.sourceURL, 'https://example.com/');
  assert.equal(answer.data.metadata.cacheState, 'miss', 'a fresh read must not claim to be a cache hit');
  assert.equal(typeof answer.data.metadata.cachedAt, 'string');
  assert.match(answer.data.markdown, /example/i);
  assert.ok(Array.isArray(answer.data.links));
  assert.match(answer.data.rawHtml, /<html/i);

  const onlyHtml = await v2Scrape({ url: 'https://example.com/', formats: ['html'] }, { timeoutMs: 10_000 });
  assert.equal(onlyHtml.data.markdown, undefined, 'a format not asked for is not sent');
  assert.ok(onlyHtml.data.html.length > 0);
});

test('a scrape refuses a representation this service cannot produce', async () => {
  // An empty success would read as "the page had no data", which is a wrong
  // answer dressed as a right one. The refusal names what is available.
  for (const formats of [['json'], ['screenshot'], ['branding'], [{ type: 'json', schema: {} }]]) {
    await assert.rejects(
      () => v2Scrape({ url: 'https://example.com/', formats }),
      (error) => error.status === 400 && /not produced by this deployment/.test(error.message),
      `${formats} must be refused`,
    );
  }
  await assert.rejects(() => v2Scrape({}, {}), /url is required/);
});

test('the developer index is passed through with its passages intact', async () => {
  let seen = null;
  const upstream = await serve((req, res) => {
    seen = { method: req.method, url: req.url };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      partial: false,
      results: [{
        id: 'issue:owner/repo#7',
        url: 'https://github.com/owner/repo/issues/7',
        title: 'connection refused',
        passages: [{ text: 'the socket path is wrong on this image' }],
      }],
    }));
  });

  try {
    const answer = await v2DeveloperSearch({ query: 'docker socket refused', k: 2 }, {
      firecrawlApiUrl: upstream.base,
      searchTimeoutMs: 2000,
      keylessFirecrawl: true,
    });

    assert.equal(seen.method, 'GET', 'this endpoint is a GET');
    assert.match(seen.url, /^\/v2\/search\/developer\?query=docker\+socket\+refused/);
    assert.match(seen.url, /k=2/);
    assert.equal(answer.results[0].id, 'issue:owner/repo#7');
    assert.equal(answer.results[0].passages[0].text, 'the socket path is wrong on this image');
  } finally {
    await upstream.close();
  }
});

test('a query is required everywhere one is expected', async () => {
  await assert.rejects(() => v2Search({}, {}), /query is required/);
  await assert.rejects(() => v2Search({ query: 'x'.repeat(1001) }, {}), /over 1000 characters/);
  await assert.rejects(() => v2DeveloperSearch({}, {}), /query is required/);
});
