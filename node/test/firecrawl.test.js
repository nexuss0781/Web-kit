import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { postJson, withDomains, search, scrape } from '../src/firecrawl.js';
import firecrawl, { rows } from '../src/providers/firecrawl.js';
import { looksUnrendered, boundText, fetchDocument } from '../src/fetcher.js';
import { loadConfig } from '../src/config.js';
import { allProviders, enabledProviders } from '../src/providers/index.js';
import { normalise } from '../src/search.js';

/** A local server, so these tests assert our request and not Firecrawl's. */
async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test('a domain restriction becomes site clauses', () => {
  assert.equal(withDomains('rust async', []), 'rust async');
  assert.equal(withDomains('rust async', undefined), 'rust async');
  assert.equal(withDomains('rust async', ['docs.rs']), 'rust async (site:docs.rs)');
  assert.equal(withDomains('x', ['https://www.example.com/a/b']), 'x (site:example.com)');
  assert.equal(withDomains('x', ['', null]), 'x');
});

test('a Firecrawl result becomes a row the rest of the service speaks', () => {
  const mapped = rows([
    { title: '  SQLite  vs  Postgres ', url: 'https://a.test/x', description: 'one' },
    { title: 'no url is dropped', description: 'orphan' },
    { url: 'https://b.test' },
  ]);

  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].title, 'SQLite vs Postgres', 'whitespace is collapsed');
  assert.equal(mapped[0].url, 'https://a.test/x');
  assert.equal(mapped[1].snippet, '', 'a result with nothing to say is not an error');

  assert.deepEqual(rows(undefined), [], 'a shape we did not expect yields nothing');
});

test('the provider stays out of the default set until a key is configured', () => {
  const withKey = enabledProviders({ firecrawlApiKey: 'fc-test' }).map((p) => p.id);
  assert.ok(withKey.includes('firecrawl'));
  assert.ok(!enabledProviders({}).map((p) => p.id).includes('firecrawl'));
  assert.ok(allProviders().some((p) => p.id === 'firecrawl'), 'it is still in the registry');
  // Naming it without a key should say what is missing, not reach the network.
  return assert.rejects(() => firecrawl.search({ query: 'x' }, {}), /FIRECRAWL_API_KEY/);
});

test('a page that yields almost no text from a lot of markup wants a browser', () => {
  // The signature of a single page app: big markup, all the text arrives later.
  assert.equal(looksUnrendered('<html>' + 'x'.repeat(60_000) + '</html>', 12), true);
  // Plenty of text from plenty of markup is a page we read fine.
  assert.equal(looksUnrendered('<html>' + 'x'.repeat(60_000) + '</html>', 40_000), false);
  // A short page with little text is a small page, not a shell to re-read.
  assert.equal(looksUnrendered('<html><body><p>hi</p></body></html>', 2), false);
  assert.equal(looksUnrendered('<html>' + 'x'.repeat(60_000) + '</html>', 900), false);
});

test('a post carries the key and the body, and reads the answer back', async () => {
  let seen = null;
  const upstream = await serve((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen = { method: req.method, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { title: 'ok' } }));
    });
  });
  try {
    const answer = await postJson(`${upstream.base}/v1/search`, { query: 'x' }, { apiKey: 'fc-secret', timeoutMs: 2000 });
    assert.equal(seen.method, 'POST');
    assert.equal(seen.auth, 'Bearer fc-secret', 'the key is a bearer token');
    assert.deepEqual(seen.body, { query: 'x' });
    assert.equal(answer.data.title, 'ok');
  } finally {
    await upstream.close();
  }
});

test('a 200 that says success:false is a failure, because that is how Firecrawl refuses', async () => {
  const upstream = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Invalid request body' }));
  });
  try {
    await assert.rejects(() => postJson(`${upstream.base}/v1/search`, {}, { apiKey: 'k', timeoutMs: 2000 }), /refused the request.*Invalid request body/s);
  } finally {
    await upstream.close();
  }
});

test('a non-2xx and a non-JSON answer are both errors that name the host', async () => {
  const bad = await serve((_req, res) => {
    res.writeHead(402, 'Payment Required');
    res.end('out of credits');
  });
  const html = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>not json</html>');
  });
  try {
    await assert.rejects(() => postJson(`${bad.base}/v1/search`, {}, { apiKey: 'k', timeoutMs: 2000 }), /402/);
    await assert.rejects(() => postJson(`${html.base}/v1/search`, {}, { apiKey: 'k', timeoutMs: 2000 }), /did not answer with JSON/);
  } finally {
    await bad.close();
    await html.close();
  }
});

test('a renderer that never answers is cut off rather than waited on', async () => {
  const upstream = await serve(() => { /* never answers */ });
  try {
    await assert.rejects(() => postJson(`${upstream.base}/v1/scrape`, {}, { apiKey: 'k', timeoutMs: 250 }), /no answer from/);
  } finally {
    upstream.close();
  }
});

test('a search asks for summaries only, and honours what the caller restricted it to', async () => {
  let seen = null;
  const upstream = await serve((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen = { path: req.url, body: JSON.parse(Buffer.concat(chunks)) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: [{ title: 'a', url: 'https://a.test' }] }));
    });
  });
  try {
    const answer = await search('sqlite vs postgres', { limit: 5, domains: ['example.com'], time_range: 'year' }, {
      firecrawlApiKey: 'fc-k',
      firecrawlApiUrl: upstream.base,
    });

    assert.equal(seen.path, '/v1/search');
    assert.equal(seen.body.limit, 5);
    assert.match(seen.body.query, /site:example\.com/, 'a domain is carried as a site clause');
    assert.equal(seen.body.tbs, 'qdr:y', 'a recency range becomes Firecrawl\'s own code');
    assert.equal(seen.body.ignoreInvalidURLs, true, 'one bad url in the index should not fail the search');
    assert.equal(seen.body.scrapeOptions, undefined, 'summaries only: fetching each result is not asked for');
    assert.equal(answer.length, 1);
  } finally {
    await upstream.close();
  }
});

test('a limit past the documented range is clamped rather than passed on', async () => {
  const seen = [];
  const upstream = await serve((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: [] }));
    });
  });
  try {
    const config = { firecrawlApiKey: 'fc-k', firecrawlApiUrl: upstream.base };
    await search('x', { limit: 5000 }, config);
    await search('x', { limit: 0 }, config);
    await search('x', { limit: -3 }, config);
    assert.deepEqual(seen.map((body) => body.limit), [50, 1, 1]);
  } finally {
    await upstream.close();
  }
});

test('a snippet arrives as text, not as the markup it was encoded in', () => {
  // Seen live: Crossref handing back `Mail&#039;s` and Wikipedia `&quot;`.
  const apostrophe = normalise(
    { url: 'https://a.test/1', title: 'Migrating from Oracle', snippet: "Mail&#039;s migration &amp; what it cost" },
    'crossref',
    1,
  );
  assert.equal(apostrophe.snippet, "Mail's migration & what it cost");

  const quoted = normalise(
    { url: 'https://a.test/2', title: 'Data &amp; Storage', snippet: '&quot;Parquet in the lake&quot;' },
    'wikipedia',
    1,
  );
  assert.equal(quoted.title, 'Data & Storage');
  assert.equal(quoted.snippet, '"Parquet in the lake"');

  // Wikipedia wraps its highlights in tags. Decoding first would turn
  // `&lt;b&gt;` into markup the API never sent.
  const marked = normalise(
    { url: 'https://a.test/3', title: 'Aurora', snippet: 'a <span class="searchmatch">light</span> display &amp; more' },
    'wikipedia',
    1,
  );
  assert.equal(marked.snippet, 'a light display & more');
  assert.ok(!marked.snippet.includes('<'), 'no markup is invented from an encoded tag');

  // Decoding happens once. `&amp;#x2764;` is a literal `&#x2764;` in the source
  // text, not a heart, and re-scanning the result would be a second decode
  // nobody asked for.
  const encoded = normalise({ url: 'https://a.test/4', snippet: 'R&amp;D &amp;#x2764;' }, 'crossref', 1);
  assert.equal(encoded.snippet, 'R&D &#x2764;');
  assert.equal(normalise({ url: 'https://a.test/4b', snippet: 'R&D &#x2764;' }, 'crossref', 1).snippet, 'R&D ❤');

  // An unknown entity is left alone rather than guessed at, and html in a
  // snippet does not become part of the title.
  assert.equal(normalise({ url: 'https://a.test/5', snippet: '&nosuchthing; <b>bold</b>' }, 'crossref', 1).snippet, '&nosuchthing; bold');
});

test('a long rendered page is held to the ceiling instead of only being called long', async () => {
  // The point of the byte ceiling is that it holds. Marking a response truncated
  // while returning all of it is a promise the response does not keep, and the
  // gap is exactly the size of one long article.
  const huge = '# heading\n\n' + 'lorem ipsum dolor sit amet '.repeat(20_000);
  let request = null;
  const origin = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><p>short</p></body></html>');
  });
  const upstream = await serve((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      request = JSON.parse(Buffer.concat(chunks));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: { markdown: huge, metadata: { title: 'long read', statusCode: 200, url: 'https://example.com/article' } },
      }));
    });
  });
  try {
    const response = await fetchDocument('https://example.com/article', { render: 'always', max_bytes: 2000 }, {
      firecrawlApiKey: 'fc-k',
      firecrawlApiUrl: upstream.base,
    });

    assert.equal(request.url, 'https://example.com/article', 'the renderer is asked for the page we were given');
    assert.equal(response.retrieval.truncated, true);
    assert.ok(response.retrieval.bytes <= 2000, `returned ${response.retrieval.bytes} bytes against a 2000 ceiling`);
    assert.ok(Buffer.byteLength(response.document.markdown, 'utf8') <= 2000);
    assert.ok(
      response.warnings.some((w) => /continues past that/.test(w)),
      'a shortened page says so, so nobody reads the cut as the whole article',
    );
    assert.equal(response.document.metadata.title, 'long read');
  } finally {
    await origin.close();
    await upstream.close();
  }
});

test('a rendered page keeps the status the renderer saw', async () => {
  const upstream = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: { markdown: '', metadata: { title: 'Nope', statusCode: 404 } },
    }));
  });
  try {
    const response = await fetchDocument('https://example.com/gone', { render: 'always' }, {
      firecrawlApiKey: 'fc-k',
      firecrawlApiUrl: upstream.base,
    });
    // Reporting 200 for a 404 would dress a missing page up as a successful read.
    assert.equal(response.retrieval.status, 404);
    assert.match(response.retrieval.content_type, /upstream 404/);
  } finally {
    await upstream.close();
  }
});

test('render asked for without a key returns the page, and says what was missing', async () => {
  const response = await fetchDocument('https://example.com/plain', { render: 'always' }, {});
  assert.ok(
    response.warnings.some((w) => /FIRECRAWL_API_KEY/.test(w)),
    'the caller is told why it did not get a browser',
  );
});

test('bounding text keeps whole characters and holds the byte count', () => {
  // Multi-byte characters are where a naive slice breaks: 3 bytes each, so a
  // string slice at N characters is a different number of bytes entirely.
  const text = 'é'.repeat(1000);
  const bound = boundText(text, 999);
  assert.equal(bound.truncated, true);
  assert.ok(bound.bytes <= 999);
  assert.ok(!bound.text.endsWith('�'), 'a split character is dropped, not handed on broken');
  assert.equal(boundText(text, 10_000).truncated, false, 'text under the ceiling is returned whole');
  assert.equal(boundText('', 10).text, '');
});

test('a scrape asks for the main content as markdown, and reuses a copy only as told', async () => {
  let seen = null;
  const upstream = await serve((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen = { path: req.url, body: JSON.parse(Buffer.concat(chunks)) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { markdown: '# hello', metadata: { title: 'hello' } } }));
    });
  });
  try {
    const page = await scrape('https://a.test/page', { maxAge: 1234 }, { firecrawlApiKey: 'fc-k', firecrawlApiUrl: upstream.base });

    assert.equal(seen.path, '/v1/scrape');
    assert.equal(seen.body.url, 'https://a.test/page');
    assert.deepEqual(seen.body.formats, ['markdown']);
    assert.equal(seen.body.onlyMainContent, true, 'navigation and footers are noise on the page we wanted');
    assert.equal(seen.body.waitFor, 1500, 'the scripts get a moment to run before we read them');
    assert.equal(seen.body.maxAge, 1234);
    assert.equal(page.markdown, '# hello');

    await scrape('https://a.test/2', {}, { firecrawlApiKey: 'fc-k', firecrawlApiUrl: upstream.base });
    assert.equal(seen.body.maxAge, undefined, 'no age is passed unless the caller chose one');
  } finally {
    await upstream.close();
  }
});
test('a deployment that forbids remote rendering never hands the URL over', async () => {
  // Everything else here resolves a name once and dials the address it checked.
  // Rendering cannot: Firecrawl resolve it again, from their network. So when a
  // deployment switches this off, the URL must not leave at all -- not even to a
  // renderer that would have answered politely.
  let asked = false;
  const upstream = await serve((_req, res) => {
    asked = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { markdown: '# rendered by firecrawl', metadata: { statusCode: 200 } } }));
  });
  const blocked = {
    firecrawlApiKey: 'fc-k',
    firecrawlApiUrl: upstream.base,
    allowRemoteRender: false,
  };

  try {
    const always = await fetchDocument('https://example.com/', { render: 'always' }, blocked);

    assert.equal(asked, false, 'render: always must not reach the renderer');
    assert.notEqual(always.document.markdown, '# rendered by firecrawl');
    assert.ok(
      always.warnings.some((w) => /remote rendering is disabled/.test(w)),
      'and the caller is told why it did not get a browser',
    );

    // auto must not escalate either. The page here is not a script shell, so
    // this asserts the switch is consulted before the heuristic rather than
    // after it: the renderer is never asked, on any path.
    const auto = await fetchDocument('https://example.com/', { render: 'auto' }, blocked);
    assert.equal(asked, false, 'render: auto must not consult the renderer when rendering is off');
  } finally {
    await upstream.close();
  }
});

test('the kill switch reads as a switch, not a truthiness trap', () => {
  // `WEBKIT_ALLOW_REMOTE_RENDER=0` has to mean off. Anything else here would
  // leave a deployment that believes it is closed quietly open.
  assert.equal(loadConfig({ WEBKIT_ALLOW_REMOTE_RENDER: '0' }).allowRemoteRender, false);
  assert.equal(loadConfig({ WEBKIT_ALLOW_REMOTE_RENDER: 'false' }).allowRemoteRender, false);
  assert.equal(loadConfig({ WEBKIT_ALLOW_REMOTE_RENDER: 'off' }).allowRemoteRender, false);
  assert.equal(loadConfig({ WEBKIT_ALLOW_REMOTE_RENDER: 'no' }).allowRemoteRender, false);
  assert.equal(loadConfig({ WEBKIT_ALLOW_REMOTE_RENDER: '1' }).allowRemoteRender, true);
  assert.equal(loadConfig({ WEBKIT_ALLOW_REMOTE_RENDER: 'true' }).allowRemoteRender, true);

  // Unset means on: rendering is the reason the key is there at all.
  assert.equal(loadConfig({}).allowRemoteRender, true);
});
