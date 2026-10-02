import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getJson, getText, url } from '../src/http.js';

/** A local server, so these tests assert the transport and not a network. */
async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test('builds a url, encoding values and dropping the empty ones', () => {
  assert.equal(
    url('https://example.com/api', { q: 'a b', skip: undefined, blank: '', none: null, n: 0 }),
    'https://example.com/api?q=a+b&n=0',
  );
});

test('reads json and text back', async () => {
  const upstream = await serve((req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, q: req.url }));
    } else {
      res.writeHead(200, { 'content-type': 'application/atom+xml' });
      res.end('<feed><entry>one</entry></feed>');
    }
  });
  try {
    assert.deepEqual(await getJson(`${upstream.base}/json`), { ok: true, q: '/json' });
    assert.equal(await getText(`${upstream.base}/atom`), '<feed><entry>one</entry></feed>');
  } finally {
    await upstream.close();
  }
});

test('a non-2xx answer is an error, not a body to parse', async () => {
  const upstream = await serve((_req, res) => {
    res.writeHead(429, 'Too Many Requests');
    res.end('slow down');
  });
  try {
    await assert.rejects(() => getJson(`${upstream.base}/x`), /429/);
    await assert.rejects(() => getText(`${upstream.base}/x`), /429/);
  } finally {
    await upstream.close();
  }
});

test('an answer that is not json is an error that says which host', async () => {
  const upstream = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>nope</html>');
  });
  try {
    await assert.rejects(() => getJson(`${upstream.base}/x`), /did not answer with JSON/);
  } finally {
    await upstream.close();
  }
});

test('a slow upstream is cut off rather than waited on', async () => {
  const upstream = await serve(() => {
    // Never answers.
  });
  try {
    await assert.rejects(() => getText(`${upstream.base}/hang`, { timeoutMs: 250 }), /no answer from/);
  } finally {
    upstream.close();
  }
});

test('an answer larger than the ceiling is refused while reading it', async () => {
  const upstream = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    // Far more than any provider should ever send, and more than it is willing
    // to buffer: the point is that it is refused, not that it is remembered.
    const chunk = 'x'.repeat(1024 * 1024);
    for (let sent = 0; sent < 64; sent += 1) res.write(chunk);
    res.end();
  });
  try {
    await assert.rejects(() => getText(`${upstream.base}/huge`, { timeoutMs: 5000 }), /exceeds/);
  } finally {
    upstream.close();
  }
});
