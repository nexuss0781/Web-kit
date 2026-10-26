import test from 'node:test';
import assert from 'node:assert/strict';
import { engineEnv, connectEnv } from '../src/settings.js';

const base = {
  host: '127.0.0.1',
  port: 8787,
  token: null,
  searxng: true,
  searxngPort: 8888,
  autoStart: true,
};

test('SearXNG is the first tier by default', () => {
  const env = engineEnv(base, {});
  assert.equal(env.WEBKIT_SEARCH_TIERS, 'searxng,firecrawl-keyless,verticals,firecrawl-key');
  assert.equal(env.WEBKIT_SEARXNG_URLS, 'http://127.0.0.1:8888');
  assert.equal(env.WEBKIT_KEYLESS_FIRECRAWL, '1');
});

test('the CLI-facing FIRECRAWL_API_URL is not passed to the engine', () => {
  // This is the loop: the CLI reads FIRECRAWL_API_URL to pick a server, and the
  // engine reads it to pick an upstream. If the first leaked into the second,
  // every keyed fallback would call this service again.
  const env = engineEnv(base, { FIRECRAWL_API_URL: 'http://127.0.0.1:8787' });
  assert.equal(env.FIRECRAWL_API_URL, undefined);
  assert.equal(env.WEBKIT_FIRECRAWL_UPSTREAM, undefined);
});

test('a genuine upstream survives under its explicit name', () => {
  const env = engineEnv(base, { FIRECRAWL_API_URL: 'http://127.0.0.1:3002' });
  assert.equal(env.FIRECRAWL_API_URL, undefined);
  assert.equal(env.WEBKIT_FIRECRAWL_UPSTREAM, 'http://127.0.0.1:3002');
});

test('disabling SearXNG removes the instance rather than leaving a dead port', () => {
  const env = engineEnv({ ...base, searxng: false }, { WEBKIT_SEARXNG_URL: 'http://127.0.0.1:8888' });
  assert.equal(env.WEBKIT_SEARXNG_URLS, undefined);
  assert.equal(env.WEBKIT_SEARXNG_URL, undefined);
  // The daemon is a separate process that re-reads its settings from this
  // environment, so the choice has to be written down, not just applied here.
  assert.equal(env.WEBKIT_SEARXNG, '0');
});

test('a SearXNG port chosen on the command line reaches the daemon', () => {
  const env = engineEnv({ ...base, searxngPort: 9123 }, {});
  assert.equal(env.WEBKIT_SEARXNG_PORT, '9123');
  assert.equal(env.WEBKIT_SEARXNG_URLS, 'http://127.0.0.1:9123');
});

test('a user-supplied tier order wins', () => {
  const env = engineEnv(base, { WEBKIT_SEARCH_TIERS: 'verticals,searxng' });
  assert.equal(env.WEBKIT_SEARCH_TIERS, 'verticals,searxng');
});

test('the shell variables point at the daemon, and carry the token only when set', () => {
  assert.deepEqual(connectEnv(base), { FIRECRAWL_API_URL: 'http://127.0.0.1:8787' });
  assert.deepEqual(connectEnv({ ...base, token: 'abc' }), {
    FIRECRAWL_API_URL: 'http://127.0.0.1:8787',
    FIRECRAWL_API_KEY: 'abc',
  });
});
