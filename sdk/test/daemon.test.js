import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// The daemon module resolves its paths when it is imported, so the home is
// redirected first. Node runs each test file in its own process, so this does
// not touch the real ~/.webkit or any other suite.
process.env.WEBKIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'webkit-daemon-'));

const { isRunning, stop, readDaemon } = await import('../src/daemon.js');
const { portFree, nextFreePort } = await import('../src/net.js');

/** An HTTP server that always answers `payload`, on a port of its choosing. */
function healthServer(payload) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('an answer that does not name the recorded instance is not our daemon', async () => {
  // The situation on Windows: a wildcard listener and a loopback listener share
  // a port, and the kernel decides per connection which one answers. A health
  // check that only looks for 200 would accept the stranger.
  const stranger = await healthServer({ status: 'ok', instance: 'someone-else' });
  try {
    assert.equal(await isRunning({ url: stranger.url, instance: 'ours' }), false);
    assert.equal(await isRunning({ url: stranger.url, instance: 'someone-else' }), true);
    // A record written before identities existed still means "something is up".
    assert.equal(await isRunning({ url: stranger.url }), true);
  } finally {
    await stranger.close();
  }
});

test('a daemon that is gone is not running', async () => {
  const gone = await healthServer({ status: 'ok' });
  await gone.close();
  assert.equal(await isRunning({ url: gone.url, instance: 'x' }), false);
});

test('a wildcard listener makes the port unavailable', async () => {
  // `exclusive: true` turns Windows' "two listeners on one port" into a failed
  // bind. Without it, this check said the port was free and the SDK would put
  // its daemon next to the stranger.
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '0.0.0.0', resolve));
  const port = blocker.address().port;

  try {
    assert.equal(await portFree(port), false);
    const chosen = await nextFreePort(port);
    assert.notEqual(chosen, port);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('stop without a daemon is a no-op, not an error', async () => {
  assert.equal(readDaemon(), null);
  assert.equal(await stop(), false);
});
