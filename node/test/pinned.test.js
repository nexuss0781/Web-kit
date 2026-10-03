import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createServer } from 'node:http';
import { pinnedGet, resolvePublic, header } from '../src/pinned.js';
import { parseUrl, UnsafeUrlError } from '../src/safety.js';

/**
 * A URL built without parseUrl, because parseUrl refuses ports that are not 80
 * or 443 -- which is right for callers and wrong here, since the point of these
 * tests is the request built after the address has been approved. The safety
 * check under test is asserted directly, above, against real URLs.
 */
function local(port, path = '/') {
  return new URL(`http://example.test:${port}${path}`);
}

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Loopback is refused by resolvePublic, which is the point of it, so the request
 * half of pinnedGet is exercised by handing it a resolver that has already
 * approved the local server. Nothing else in the function changes.
 */
const allowLoopback = () => ({ host: '127.0.0.1', address: '127.0.0.1', family: 4 });

test('a private address is refused before a socket is opened', async () => {
  for (const url of [
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://169.254.169.254/',
    'http://10.0.0.1/',
    'http://[::ffff:127.0.0.1]/',
    'http://localhost/',
  ]) {
    await assert.rejects(() => resolvePublic(parseUrl(url)), UnsafeUrlError, `${url} must be refused`);
  }
});

test('resolution returns an address to dial, not a name to look up again', async () => {
  // The whole defence is that there is no second lookup. resolvePublic hands back
  // a concrete address and its family, and that is what the connection is built
  // from, so a name that answers differently next time has nothing to influence.
  const resolved = await resolvePublic(parseUrl('https://example.com/'));
  assert.ok(net.isIP(resolved.address), `expected an address, got ${resolved.address}`);
  assert.ok([4, 6].includes(resolved.family));
  assert.equal(resolved.host, 'example.com', 'the name is kept for Host and TLS');
});

test('a host that does not resolve is named in the refusal', async () => {
  await assert.rejects(() => resolvePublic(parseUrl('http://this-name-does-not-exist.invalid/')), /cannot resolve/);
});

test('the request carries the name asked for, even though the address is dialled', async () => {
  // The connection goes to the checked address, but the site must still see the
  // host that was requested. A Host header that disagreed with the URL would be
  // a different request to the one the caller asked for, and would route to
  // whatever the wrong host serves.
  const server = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body>host=${req.headers.host} agent=${req.headers['user-agent']}</body></html>`);
  });
  try {
    const response = await pinnedGet(local(server.port, '/page?q=1'), {
      resolve: allowLoopback,
      headers: { 'user-agent': 'Web-Kit-test' },
    });

    assert.equal(response.status, 200);
    assert.match(response.body.toString('utf8'), /host=example\.test/, 'the Host header names the host asked for');
    assert.match(response.body.toString('utf8'), /agent=Web-Kit-test/);
    assert.equal(header(response, 'Content-Type'), 'text/html', 'read case-insensitively');
  } finally {
    await server.close();
  }
});

test('a redirect is reported, not followed', async () => {
  // Following is the caller's decision: /v1/fetch checks every hop itself, and
  // a hop it does not know about is a hop nobody vetted.
  const server = await serve((_req, res) => {
    res.writeHead(302, { location: 'http://elsewhere.test/' });
    res.end();
  });
  try {
    const response = await pinnedGet(local(server.port), { resolve: allowLoopback });
    assert.equal(response.status, 302);
    assert.equal(header(response, 'location'), 'http://elsewhere.test/');
  } finally {
    await server.close();
  }
});

test('a response past the ceiling is cut at the socket, and the cut is reported', async () => {
  const server = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('x'.repeat(200_000));
  });
  try {
    const response = await pinnedGet(local(server.port), {
      resolve: allowLoopback,
      maxBytes: 1000,
    });

    assert.equal(response.truncated, true, 'a short read is reported rather than passed off as the whole page');
    assert.ok(response.body.length <= 1000, `kept ${response.body.length} bytes against a 1000 ceiling`);
  } finally {
    await server.close();
  }
});

test('a slow host is cut off rather than waited on', async () => {
  const server = await serve(() => { /* accepts and never answers */ });
  try {
    await assert.rejects(
      () => pinnedGet(local(server.port), { resolve: allowLoopback, timeoutMs: 250 }),
      /no answer from/,
    );
  } finally {
    server.close();
  }
});

test('a header read is total: missing, empty and repeated all have one answer', () => {
  const response = { headers: { 'content-type': 'text/html', 'set-cookie': ['a=1', 'b=2'], 'x-empty': undefined } };
  assert.equal(header(response, 'Content-Type'), 'text/html');
  assert.equal(header(response, 'SET-COOKIE'), 'a=1, b=2');
  assert.equal(header(response, 'location'), null, 'a missing header is null, not undefined');
  assert.equal(header(response, 'x-empty'), null);
  assert.equal(header({}, 'anything'), null);
});
test('the documented error codes are the ones the service actually emits', async () => {
  // The specification claims a closed vocabulary of codes. If one is renamed or
  // dropped from the code and left in the spec, a caller branching on it is
  // quietly broken, and nothing else would notice.
  const { readFile } = await import('node:fs/promises');
  const spec = await readFile(new URL('../../openapi.yaml', import.meta.url), 'utf8');

  const sources = await Promise.all(
    ['server.js', 'search.js', 'fetcher.js', 'safety.js', 'robots.js', 'firecrawl.js', 'pinned.js']
      .map((name) => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8')),
  );
  // Only `code:` assignments count. A bare E_ match would also catch config
  // names like WEBKIT_ROBOTS_CACHE_TTL_MS, which are not error codes.
  const emitted = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/code:\s*'(E_[A-Z_]+)'/g)) emitted.add(match[1]);
    for (const match of source.matchAll(/\.code\s*=\s*'(E_[A-Z_]+)'/g)) emitted.add(match[1]);
    // A default code is named positionally in the FetchError signature.
    for (const match of source.matchAll(/code\s*=\s*'(E_[A-Z_]+)'/g)) emitted.add(match[1]);
    // ...and most are passed as its third argument at the call site.
    for (const match of source.matchAll(/new FetchError\((?:[^()]|\([^()]*\))*?'(E_[A-Z_]+)'/g)) emitted.add(match[1]);
    // E_INTERNAL is the fallback in sendError rather than a throw site.
    if (/error\.code\s*\?\?\s*'E_INTERNAL'/.test(source)) emitted.add('E_INTERNAL');
  }

  const documented = [...spec.matchAll(/^\s+- (E_[A-Z_]+)\s+#/gm)].map((match) => match[1]);
  assert.ok(documented.length > 0, 'the spec lists error codes at all');

  for (const code of documented) {
    assert.ok(emitted.has(code), `${code} is documented but nothing emits it`);
  }
  for (const code of emitted) {
    assert.ok(documented.includes(code), `${code} is emitted but undocumented`);
  }
});
