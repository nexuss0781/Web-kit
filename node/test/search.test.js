import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { search } from '../src/search.js';
import { describeProviders } from '../src/providers/index.js';

/** A stand-in SearXNG, so ranking and failover are tested without a network. */
function instance(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

const results = (rows) => (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ results: rows.map((row) => ({ title: row[0], url: row[1], content: row[2] ?? '' })) }));
  assert.ok(url.searchParams.get('q'));
};

// The providers are pinned to searxng against a local stand-in throughout this
// file: the point is the ranking and failover logic, and none of these assertions
// should depend on somebody else's server being up.
const only = (searxngUrls, providers = ['searxng']) => ({ searxngUrls, providers, searchTimeoutMs: 5000 });
const defaultDeployment = (searxngUrls) => ({ searxngUrls, providers: [], searchTimeoutMs: 5000 });

test('the registry reports what exists and what this deployment will use', () => {
  const described = describeProviders(defaultDeployment(['http://searxng:8080']));
  const byId = Object.fromEntries(described.map((entry) => [entry.id, entry]));

  assert.ok(described.length > 1, 'more than one provider is available');
  assert.ok(byId.wikipedia.enabled, 'a keyless provider needs no configuration');
  assert.ok(byId.searxng.enabled, 'configured instances turn searxng on');
  assert.ok(described.every((entry) => entry.capabilities.includes('search')));
  // Without instances there is nothing to point searxng at, so it stays off
  // rather than reaching for a public one that would refuse us.
  assert.equal(describeProviders(defaultDeployment([])).find((entry) => entry.id === 'searxng').enabled, false);
});

test('results are deduplicated by canonical url and ranked by agreement', async () => {
  const first = await instance(results([
    ['Only A', 'https://a.test/page'],
    ['Both', 'https://both.test/page'],
    ['A again', 'https://a.test/page?utm_source=news'],
  ]));
  try {
    const response = await search({ query: 'x' }, only([first.url]));
    const urls = response.results.map((result) => result.url);

    assert.equal(response.providers.searxng.status, 'ok');
    assert.equal(response.results.length, 2, 'the tracking-parameter duplicate collapses into one');
    assert.deepEqual(urls, ['https://a.test/page', 'https://both.test/page'], 'rank 1 outranks rank 2');
    assert.deepEqual(response.results[0].providers, ['searxng']);
    assert.ok(response.results[0].score > response.results[1].score);
  } finally {
    await first.close();
  }
});

test('fanout fuses across instances, so agreement lifts the shared result', async () => {
  const one = await instance(results([['Shared', 'https://s.test/'], ['A', 'https://a.test/']]));
  const two = await instance(results([['Shared', 'https://s.test/'], ['B', 'https://b.test/']]));
  try {
    const response = await search({ query: 'x', mode: 'fanout' }, only([one.url, two.url]));
    assert.equal(response.results.length, 3);
    const shared = response.results[0];
    assert.equal(shared.url, 'https://s.test/', 'the page both instances found is ranked first');
    assert.deepEqual(shared.provider_ranks, { searxng: 1 });
    assert.equal(response.timing.providers_asked, 1, 'one provider, fanned out over two instances');
    assert.deepEqual(response.warnings, [], 'both instances answered, so there is nothing to warn about');
  } finally {
    await one.close();
    await two.close();
  }
});

/**
 * Stand-ins with the shape the registry expects. These make the mode rules
 * testable on their own: single, fallback and fanout differ only in which
 * providers they bother to ask, and that has nothing to do with SearXNG.
 */
const row = (title, url) => ({ title, url });

const fake = (id, rows, behaviour = {}) => ({
  id,
  label: id,
  capabilities: ['search'],
  search: async () => {
    if (behaviour.fail) throw new Error('upstream said no');
    return { latency: 1, rows };
  },
});

const withFakes = (providers) => ({ providers, searchTimeoutMs: 5000 });

test('single asks one provider and stops there', async () => {
  const response = await search({ query: 'x', mode: 'single' }, withFakes([
    fake('alpha', [row('A', 'https://a.test/')]),
    fake('beta', [row('B', 'https://b.test/')]),
  ]));
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].url, 'https://a.test/');
  assert.deepEqual(Object.keys(response.providers), ['alpha'], 'beta was never asked');
});

test('fallback steps past a provider that answers with nothing', async () => {
  const response = await search({ query: 'x', mode: 'fallback' }, withFakes([
    fake('empty', []),
    fake('broken', [row('ignored', 'https://x.test/')], { fail: true }),
    fake('useful', [row('Found', 'https://found.test/')]),
    fake('late', [row('Too late', 'https://late.test/')]),
  ]));
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].url, 'https://found.test/');
  assert.ok(!response.providers.late, 'the fourth provider is never reached');
  assert.match(response.warnings.join(' '), /broken failed/);
});

test('fanout asks everyone, and one broken provider does not sink the search', async () => {
  const response = await search({ query: 'x', mode: 'fanout' }, withFakes([
    fake('alpha', [row('Shared', 'https://s.test/')]),
    fake('broken', [], { fail: true }),
    fake('beta', [row('Shared', 'https://s.test/'), row('Only beta', 'https://b.test/')]),
  ]));
  assert.equal(response.providers.broken.status, 'unreachable');
  assert.equal(response.providers.alpha.status, 'ok');
  // The page two providers agree on outranks the one only beta found.
  assert.deepEqual(response.results.map((row) => row.url), ['https://s.test/', 'https://b.test/']);
  assert.deepEqual(response.results[0].providers, ['alpha', 'beta']);
});

test('an unknown provider name is ignored rather than fatal', async () => {
  const response = await search({ query: 'x' }, withFakes(['nope', fake('alpha', [row('A', 'https://a.test/')])]));
  assert.equal(response.results.length, 1);
});

test('an unreachable instance is a warning, and the next one is tried', async () => {
  const working = await instance(results([['Found', 'https://found.test/']]));
  try {
    const response = await search({ query: 'x' }, only(['http://127.0.0.1:1/', working.url]));
    assert.equal(response.results.length, 1);
    assert.match(response.warnings.join(' '), /instance .* failed/);
    assert.equal(response.timing.providers_asked, 1);
    assert.match(response.warnings.join(' '), /instance .* failed/);
  } finally {
    await working.close();
  }
});

test('every instance failing is reported, not dressed up as no results', async () => {
  const response = await search({ query: 'x' }, only(['http://127.0.0.1:1/', 'http://127.0.0.1:2/']));
  assert.deepEqual(response.results, []);
  assert.equal(response.providers.searxng.status, 'unreachable');
  assert.equal(response.warnings.length, 2);
});

test('limit is honoured and clamped to the documented range', async () => {
  const rows = Array.from({ length: 30 }, (_unused, index) => [`R${index}`, `https://s${index}.test/`]);
  const server = await instance(results(rows));
  try {
    assert.equal((await search({ query: 'x', limit: 5 }, only([server.url]))).results.length, 5);
    assert.equal((await search({ query: 'x', limit: 9999 }, only([server.url]))).results.length, 30);
  } finally {
    await server.close();
  }
});
