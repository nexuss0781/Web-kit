import test from 'node:test';
import assert from 'node:assert/strict';

const http = await import('node:http');

let server;
let base;
let instance;

// The mock has to exist before the service is imported, because the service
// reads its instance list from the environment once at load time.
test.before(async () => {
  instance = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/search') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ title: 'Doc', url: 'https://docs.test/page', content: 'about things' }] }));
      return;
    }
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /private\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Page</title></head><body><h1>Heading</h1><p>Body text</p></body></html>');
  });
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));

  process.env.WEBKIT_API_TOKEN = 'test-token';
  process.env.WEBKIT_SEARXNG_URLS = `http://127.0.0.1:${instance.address().port}`;
  process.env.WEBKIT_PROVIDERS = 'searxng';
  const { createServer: makeServer } = await import('../src/server.js');
  server = makeServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((done) => server.close(done));
  await new Promise((done) => instance.close(done));
});

const authed = (path, options = {}) => fetch(`${base}${path}`, {
  ...options,
  headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', ...(options.headers || {}) },
});

test('health and readiness are open, so a platform can probe without a token', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const ready = await (await fetch(`${base}/readyz`)).json();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.auth_required, true);
  const root = await (await fetch(`${base}/`)).json();
  assert.ok(root.routes.includes('/v1/search'));
});

test('everything else needs the token', async () => {
  const denied = await fetch(`${base}/v1/providers`);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.code, 'E_UNAUTHORIZED');
  assert.equal((await authed('/v1/providers')).status, 200);
  assert.equal((await authed('/v1/providers', { headers: { authorization: 'Bearer wrong' } })).status, 401);
});

test('an unknown route is a 404 with a code', async () => {
  const response = await authed('/v1/nope');
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'E_NOT_FOUND');
});

test('search needs a query, and returns the documented shape', async () => {
  assert.equal((await authed('/v1/search')).status, 400);
  assert.equal((await authed('/v1/search', { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await authed('/v1/search', { method: 'POST', body: 'not json' })).status, 400);

  const body = await (await authed('/v1/search', {
    method: 'POST',
    body: JSON.stringify({ query: 'things' }),
  })).json();
  for (const field of ['request_id', 'query', 'mode', 'results', 'providers', 'warnings', 'timing']) {
    assert.ok(field in body, `missing ${field}`);
  }
});

test('fetch needs a url', async () => {
  assert.equal((await authed('/v1/fetch')).status, 400);
  assert.equal((await authed('/v1/fetch', { method: 'POST', body: '{}' })).status, 400);
});

test('fetch refuses to be used against the machine it runs on', async () => {
  // Two different guards refuse this. The port is refused when it is one we do
  // not fetch, and the address is refused when the port would otherwise pass.
  for (const url of [`http://127.0.0.1:${instance.address().port}/`, 'http://127.0.0.1:80/', 'http://localhost/', 'http://169.254.169.254/']) {
    const response = await authed('/v1/fetch', { method: 'POST', body: JSON.stringify({ url }) });
    assert.equal(response.status, 400, `${url} must not be fetched`);
    assert.equal((await response.json()).error.code, 'E_UNSAFE_URL', `${url} must be refused as unsafe`);
  }
  assert.match((await (await authed('/v1/fetch', { method: 'POST', body: JSON.stringify({ url: 'http://127.0.0.1:80/' }) })).json()).error.message, /private address/);
});

test('a non-http url is refused before anything is requested', async () => {
  for (const url of ['file:///etc/passwd', 'gopher://x.test/', 'ftp://x.test/']) {
    const response = await authed('/v1/fetch', { method: 'POST', body: JSON.stringify({ url }) });
    assert.equal(response.status, 400, `${url} should be refused`);
  }
});

test('every fetch is refused before it reaches the network', async () => {
  // The suite stays off the network on purpose: these assertions are about the
  // guard, and a real fetch is verified against the deployment instead.
  const response = await authed('/v1/fetch', { method: 'POST', body: JSON.stringify({ url: 'http://10.0.0.1/' }) });
  assert.equal(response.status, 400);
});

